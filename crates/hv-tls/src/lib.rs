//! TLS 1.3 between HataVoice clients and their server, pinned to the server's Ed25519 key.
//!
//! There is no certificate authority: the server key (SK, the one invite links already pin)
//! signs the certificate chain, and the client accepts a chain only when the issuer's public
//! key is the one it expects. Names and clocks play no part in trust.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use hv_roster::{Identity, PublicKey};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose,
    PKCS_ECDSA_P256_SHA256, PKCS_ED25519, date_time_ymd,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, aws_lc_rs};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};

pub const ISSUER_NAME: &str = "HataVoice server";
pub const SAN: &str = "hatavoice.invalid";

/// DER of an Ed25519 SubjectPublicKeyInfo up to the 32 key bytes.
const ED25519_SPKI_PREFIX: [u8; 10] = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// PKCS#8 wrapper of an Ed25519 seed, so `Identity` can sign certificates without a second copy of its key logic.
const ED25519_PKCS8_PREFIX: [u8; 16] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/// Only the hybrid post-quantum exchange: a recording of today's traffic must not become readable
/// once X25519 breaks. Peers that offer anything else are refused.
pub fn pq_provider() -> Arc<CryptoProvider> {
    let mut provider = aws_lc_rs::default_provider();
    provider.kx_groups = vec![aws_lc_rs::kx_group::X25519MLKEM768];
    Arc::new(provider)
}

/// A fresh leaf certificate (ECDSA P-256, made in memory on every start) signed by the server key.
/// Chain order is `[leaf, issuer]`.
fn issue(server_key: &Identity) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let mut pkcs8 = [0u8; 48];
    pkcs8[..16].copy_from_slice(&ED25519_PKCS8_PREFIX);
    pkcs8[16..].copy_from_slice(&server_key.seed());
    let sk = KeyPair::from_pkcs8_der_and_sign_algo(&PrivatePkcs8KeyDer::from(&pkcs8[..]), &PKCS_ED25519).map_err(|e| e.to_string())?;

    // The validity window spans everything a clock can say, so a wrong date on a friend's PC never matters.
    let mut ca = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    ca.distinguished_name.push(DnType::CommonName, ISSUER_NAME);
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    ca.not_before = date_time_ymd(1975, 1, 1);
    ca.not_after = date_time_ymd(9999, 12, 31);
    let ca_cert = ca.self_signed(&sk).map_err(|e| e.to_string())?;
    let issuer = Issuer::new(ca, sk);

    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut leaf = CertificateParams::new(vec![SAN.to_string()]).map_err(|e| e.to_string())?;
    leaf.distinguished_name.push(DnType::CommonName, SAN);
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf.not_before = date_time_ymd(1975, 1, 1);
    leaf.not_after = date_time_ymd(9999, 12, 31);
    let leaf_cert = leaf.signed_by(&leaf_key, &issuer).map_err(|e| e.to_string())?;

    Ok((
        vec![leaf_cert.der().clone(), ca_cert.der().clone()],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der())),
    ))
}

/// TLS 1.3 only, hybrid key exchange only, presenting `[leaf, issuer]` signed by `server_key`.
pub fn server_config(server_key: &Identity) -> Result<ServerConfig, String> {
    let (chain, key) = issue(server_key)?;
    ServerConfig::builder_with_provider(pq_provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|e| e.to_string())
}

/// Checks the issuer of the server's certificate: it must be an Ed25519 key, and `expected` (the pinned SK;
/// `None` accepts any key).
///
/// The issuer key the server presented is written to `seen`, but only once a certificate chain with an Ed25519
/// issuer has arrived: a connection that fails earlier (server offline, TLS alert, non-hybrid peer) leaves it
/// untouched. Use a fresh `seen` slot for every connection attempt. A swapped server is `seen == Some(k)` with
/// `Some(k) != expected`; an empty slot says nothing about the key. With `expected == None` the key is written
/// before the leaf signature and the handshake signature are checked, so trust it only after the handshake succeeded.
/// Session resumption is off, so the check (and the write) happens on every handshake.
pub fn client_config(expected: Option<PublicKey>, seen: Arc<Mutex<Option<PublicKey>>>) -> ClientConfig {
    client_config_with(pq_provider(), expected, seen)
}

fn client_config_with(provider: Arc<CryptoProvider>, expected: Option<PublicKey>, seen: Arc<Mutex<Option<PublicKey>>>) -> ClientConfig {
    let mut config = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("the aws-lc-rs provider speaks TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { expected, seen, provider }))
        .with_no_client_auth();
    // A resumed session skips the certificate check, and with it the write to `seen`.
    config.resumption = rustls::client::Resumption::disabled();
    config
}

#[derive(Debug)]
struct Pinned {
    expected: Option<PublicKey>,
    seen: Arc<Mutex<Option<PublicKey>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let issuer = intermediates.first().ok_or_else(|| rustls::Error::General("no issuer certificate".into()))?;
        // The issuer certificate itself is not validated: only its key matters, and the leaf must verify against it.
        let anchor = webpki::anchor_from_trusted_cert(issuer).map_err(|e| rustls::Error::General(format!("{e:?}")))?;

        let key = anchor
            .subject_public_key_info
            .as_ref()
            .strip_prefix(ED25519_SPKI_PREFIX.as_slice())
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
            .map(PublicKey)
            .ok_or_else(|| rustls::Error::General("issuer is not an Ed25519 key".into()))?;
        *self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(key);
        if self.expected.is_some_and(|expected| expected != key) {
            return Err(rustls::Error::General("server key changed".into()));
        }

        let leaf = webpki::EndEntityCert::try_from(end_entity).map_err(|e| rustls::Error::General(format!("{e:?}")))?;
        // No name check: the server is reached by address, and the pinned key already says who it is.
        leaf.verify_for_usage(
            self.provider.signature_verification_algorithms.all,
            &[anchor],
            &[],
            // Time takes no part in trust: both certificates span 1975-9999, and a wrong clock must not break a call.
            UnixTime::since_unix_epoch(Duration::from_secs(946_684_800)),
            webpki::KeyUsage::server_auth(),
            None,
            None,
        )
        .map_err(|e| rustls::Error::General(format!("{e:?}")))?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 is not allowed".into()))
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use hv_roster::{Identity, PublicKey};
    use rustls::client::danger::ServerCertVerifier;
    use rustls::crypto::aws_lc_rs;
    use rustls::pki_types::{ServerName, UnixTime};
    use rustls::NamedGroup;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn pub_of(seed: [u8; 32]) -> PublicKey {
        Identity::from_seed(seed).public()
    }

    fn seen_slot() -> Arc<Mutex<Option<PublicKey>>> {
        Arc::new(Mutex::new(None))
    }

    /// A TLS server on a free local port that echoes four bytes.
    async fn echo_server(seed: [u8; 32]) -> u16 {
        let config = server_config(&Identity::from_seed(seed)).unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                    let mut buf = [0u8; 4];
                    if tls.read_exact(&mut buf).await.is_ok() {
                        let _ = tls.write_all(&buf).await;
                        let _ = tls.flush().await;
                    }
                });
            }
        });
        port
    }

    async fn connect(config: impl Into<Arc<rustls::ClientConfig>>, port: u16) -> io::Result<NamedGroup> {
        let connector = tokio_rustls::TlsConnector::from(config.into());
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        let mut tls = connector.connect(ServerName::try_from(SAN).unwrap(), tcp).await?;
        tls.write_all(b"ping").await?;
        let mut buf = [0u8; 4];
        tls.read_exact(&mut buf).await?;
        assert_eq!(&buf, b"ping");
        Ok(tls.get_ref().1.negotiated_key_exchange_group().unwrap().name())
    }

    fn pinned(expected: Option<PublicKey>) -> Pinned {
        Pinned { expected, seen: seen_slot(), provider: pq_provider() }
    }

    fn verify_at(verifier: &Pinned, chain: &[rustls::pki_types::CertificateDer<'static>], secs: u64) -> Result<(), rustls::Error> {
        verifier
            .verify_server_cert(
                &chain[0],
                &chain[1..],
                &ServerName::try_from(SAN).unwrap(),
                &[],
                UnixTime::since_unix_epoch(Duration::from_secs(secs)),
            )
            .map(|_| ())
    }

    #[tokio::test]
    async fn pinned_key_connects_with_the_hybrid_key_exchange() {
        let port = echo_server([2; 32]).await;
        let seen = seen_slot();
        let group = connect(client_config(Some(pub_of([2; 32])), seen.clone()), port).await.unwrap();
        assert_eq!(group, NamedGroup::X25519MLKEM768);
        assert_eq!(*seen.lock().unwrap(), Some(pub_of([2; 32])));
    }

    #[tokio::test]
    async fn another_key_is_refused_and_reported() {
        let port = echo_server([2; 32]).await;
        let seen = seen_slot();
        let error = connect(client_config(Some(pub_of([3; 32])), seen.clone()), port).await.unwrap_err();
        assert!(error.to_string().contains("server key changed"), "{error}");
        assert_eq!(*seen.lock().unwrap(), Some(pub_of([2; 32])));
    }

    #[tokio::test]
    async fn unpinned_client_learns_the_key() {
        let port = echo_server([2; 32]).await;
        let seen = seen_slot();
        connect(client_config(None, seen.clone()), port).await.unwrap();
        assert_eq!(*seen.lock().unwrap(), Some(pub_of([2; 32])));
    }

    #[test]
    fn certificate_check_ignores_the_clock() {
        let (chain, _) = issue(&Identity::from_seed([2; 32])).unwrap();
        let verifier = pinned(Some(pub_of([2; 32])));
        // 1970-01-01 (a dead BIOS battery), 2001-01-01 and 2090-01-01: a friend's PC must still connect.
        verify_at(&verifier, &chain, 0).unwrap();
        verify_at(&verifier, &chain, 978_307_200).unwrap();
        verify_at(&verifier, &chain, 3_786_912_000).unwrap();
    }

    #[test]
    fn a_leaf_not_signed_by_the_issuer_is_refused() {
        let (honest, _) = issue(&Identity::from_seed([2; 32])).unwrap();
        let (other, _) = issue(&Identity::from_seed([4; 32])).unwrap();
        // The attacker shows the pinned key's own issuer certificate next to a leaf that key never signed.
        let chain = [honest[0].clone(), other[1].clone()];
        let verifier = pinned(Some(pub_of([4; 32])));
        // The pin matches, so it is the signature that fails, not the key comparison.
        let error = verify_at(&verifier, &chain, 1_800_000_000).unwrap_err();
        assert!(!error.to_string().contains("server key changed"), "{error}");
    }

    #[tokio::test]
    async fn classic_key_exchange_alone_is_refused() {
        let port = echo_server([2; 32]).await;
        let mut classic = aws_lc_rs::default_provider();
        classic.kx_groups = vec![aws_lc_rs::kx_group::X25519];
        let config = client_config_with(Arc::new(classic), Some(pub_of([2; 32])), seen_slot());
        let error = connect(config, port).await.unwrap_err();
        assert!(error.to_string().contains("HandshakeFailure"), "{error}");
    }

    #[tokio::test]
    async fn offline_server_leaves_seen_empty() {
        // Nothing listens here: a caller must never read the empty slot as a swapped server.
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let seen = seen_slot();
        assert!(connect(client_config(Some(pub_of([2; 32])), seen.clone()), port).await.is_err());
        assert_eq!(*seen.lock().unwrap(), None);
    }

    #[tokio::test]
    async fn resumption_is_disabled() {
        let port = echo_server([2; 32]).await;
        let seen = seen_slot();
        let config = Arc::new(client_config(Some(pub_of([2; 32])), seen.clone()));
        // A resumed session skips the certificate check, so `seen` would stay empty on the second connection.
        for _ in 0..3 {
            *seen.lock().unwrap() = None;
            connect(config.clone(), port).await.unwrap();
            assert_eq!(*seen.lock().unwrap(), Some(pub_of([2; 32])));
        }
    }
}
