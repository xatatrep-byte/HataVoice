//! A small RTMP publisher, enough to stream to Twitch, YouTube or any RTMP server: the simple handshake, chunked
//! messages, the AMF0 commands of a publisher (connect, createStream, publish), and FLV tags of H.264 and AAC — the
//! sequence headers first, then the frames. Over plain TCP or TLS (`rtmps://`).

use std::collections::HashMap;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Our chunk size: big frames go in few chunks.
pub const CHUNK_SIZE: u32 = 4096;
const HANDSHAKE_SIZE: usize = 1536;
/// No message we take is bigger: the server sends small ones only.
const MAX_MESSAGE: u32 = 1 << 20;

const CSID_CONTROL: u32 = 2;
const CSID_COMMAND: u32 = 3;
const CSID_AUDIO: u32 = 5;
const CSID_VIDEO: u32 = 6;

pub const TYPE_SET_CHUNK_SIZE: u8 = 1;
pub const TYPE_USER_CONTROL: u8 = 4;
pub const TYPE_AUDIO: u8 = 8;
pub const TYPE_VIDEO: u8 = 9;
pub const TYPE_DATA: u8 = 18;
pub const TYPE_COMMAND: u8 = 20;

/// Where to stream: the server, its application, the full address (tcUrl).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub app: String,
    pub tc_url: String,
}

/// An `rtmp://host[:port]/app` or `rtmps://…` address; nothing else.
pub fn parse_url(url: &str) -> Option<Endpoint> {
    let (tls, rest) = if let Some(rest) = url.strip_prefix("rtmps://") {
        (true, rest)
    } else {
        (false, url.strip_prefix("rtmp://")?)
    };
    let (authority, app) = rest.split_once('/')?;
    let app = app.trim_end_matches('/');
    if app.is_empty() || authority.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (authority, if tls { 443 } else { 1935 }),
    };
    if host.is_empty() {
        return None;
    }
    let scheme = if tls { "rtmps" } else { "rtmp" };
    Some(Endpoint { tls, host: host.into(), port, app: app.into(), tc_url: format!("{scheme}://{host}:{port}/{app}") })
}

// ---- AMF0: just what a publisher says and hears.

#[derive(Debug, Clone, PartialEq)]
pub enum Amf {
    Number(f64),
    Bool(bool),
    Str(String),
    Object(Vec<(String, Amf)>),
    /// A strict array (Enhanced RTMP's `fourCcList`).
    Array(Vec<Amf>),
    Null,
}

impl Amf {
    pub fn get(&self, key: &str) -> Option<&Amf> {
        match self {
            Amf::Object(props) => props.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Amf::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Amf::Number(n) => Some(*n),
            _ => None,
        }
    }
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

pub fn encode(values: &[Amf]) -> Vec<u8> {
    fn one(out: &mut Vec<u8>, value: &Amf) {
        match value {
            Amf::Number(n) => {
                out.push(0x00);
                out.extend_from_slice(&n.to_be_bytes());
            }
            Amf::Bool(b) => out.extend_from_slice(&[0x01, u8::from(*b)]),
            Amf::Str(s) => {
                out.push(0x02);
                put_str(out, s);
            }
            Amf::Object(props) => {
                out.push(0x03);
                for (key, value) in props {
                    put_str(out, key);
                    one(out, value);
                }
                out.extend_from_slice(&[0, 0, 0x09]);
            }
            Amf::Array(items) => {
                out.push(0x0A);
                out.extend_from_slice(&(items.len() as u32).to_be_bytes());
                for item in items {
                    one(out, item);
                }
            }
            Amf::Null => out.push(0x05),
        }
    }
    let mut out = Vec::new();
    for value in values {
        one(&mut out, value);
    }
    out
}

/// The values of an AMF0 message; what it cannot read ends the list.
pub fn decode(mut data: &[u8]) -> Vec<Amf> {
    fn take<'a>(data: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
        if data.len() < n {
            return None;
        }
        let (head, tail) = data.split_at(n);
        *data = tail;
        Some(head)
    }
    fn string(data: &mut &[u8]) -> Option<String> {
        let len = u16::from_be_bytes(take(data, 2)?.try_into().ok()?) as usize;
        Some(String::from_utf8_lossy(take(data, len)?).into_owned())
    }
    fn props(data: &mut &[u8], depth: u8) -> Option<Vec<(String, Amf)>> {
        let mut props = Vec::new();
        loop {
            let key = string(data)?;
            if key.is_empty() && data.first() == Some(&0x09) {
                take(data, 1)?;
                return Some(props);
            }
            props.push((key, one(data, depth + 1)?));
        }
    }
    fn one(data: &mut &[u8], depth: u8) -> Option<Amf> {
        if depth > 8 {
            return None;
        }
        match take(data, 1)?[0] {
            0x00 => Some(Amf::Number(f64::from_be_bytes(take(data, 8)?.try_into().ok()?))),
            0x01 => Some(Amf::Bool(take(data, 1)?[0] != 0)),
            0x02 => Some(Amf::Str(string(data)?)),
            0x03 => Some(Amf::Object(props(data, depth)?)),
            0x05 | 0x06 => Some(Amf::Null),
            0x08 => {
                take(data, 4)?;
                Some(Amf::Object(props(data, depth)?))
            }
            0x0A => {
                let count = u32::from_be_bytes(take(data, 4)?.try_into().ok()?).min(64);
                (0..count).map(|_| one(data, depth + 1)).collect::<Option<Vec<_>>>().map(Amf::Array)
            }
            _ => None,
        }
    }
    let mut values = Vec::new();
    while !data.is_empty() {
        match one(&mut data, 0) {
            Some(value) => values.push(value),
            None => break,
        }
    }
    values
}

// ---- Chunks.

/// One whole message, as it came or goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub kind: u8,
    pub stream: u32,
    pub timestamp: u32,
    pub payload: Vec<u8>,
}

/// A message as chunks of `chunk_size`, each with a full header the first time (format 0) and a bare one after.
pub fn chunks(csid: u32, message: &Message, chunk_size: u32) -> Vec<u8> {
    let extended = message.timestamp >= 0xFF_FFFF;
    let basic = |fmt: u8| -> Vec<u8> {
        if csid < 64 {
            vec![(fmt << 6) | csid as u8]
        } else {
            vec![fmt << 6, (csid - 64) as u8]
        }
    };
    let mut out = basic(0);
    let ts = if extended { 0xFF_FFFF } else { message.timestamp };
    out.extend_from_slice(&ts.to_be_bytes()[1..]);
    out.extend_from_slice(&(message.payload.len() as u32).to_be_bytes()[1..]);
    out.push(message.kind);
    out.extend_from_slice(&message.stream.to_le_bytes());
    if extended {
        out.extend_from_slice(&message.timestamp.to_be_bytes());
    }
    for (i, piece) in message.payload.chunks(chunk_size as usize).enumerate() {
        if i > 0 {
            out.extend(basic(3));
            if extended {
                out.extend_from_slice(&message.timestamp.to_be_bytes());
            }
        }
        out.extend_from_slice(piece);
    }
    out
}

#[derive(Default, Clone)]
struct Partial {
    timestamp: u32,
    delta: u32,
    length: u32,
    kind: u8,
    stream: u32,
    extended: bool,
    payload: Vec<u8>,
}

/// Reads whole messages out of the chunks the other side sends.
pub struct ChunkReader<R> {
    io: R,
    chunk_size: u32,
    streams: HashMap<u32, Partial>,
}

impl<R: AsyncRead + Unpin> ChunkReader<R> {
    pub fn new(io: R) -> Self {
        Self { io, chunk_size: 128, streams: HashMap::new() }
    }

    async fn u8(&mut self) -> std::io::Result<u8> {
        self.io.read_u8().await
    }

    async fn be(&mut self, n: usize) -> std::io::Result<u32> {
        let mut buf = [0u8; 4];
        self.io.read_exact(&mut buf[4 - n..]).await?;
        Ok(u32::from_be_bytes(buf))
    }

    pub async fn next(&mut self) -> std::io::Result<Message> {
        loop {
            let first = self.u8().await?;
            let fmt = first >> 6;
            let csid = match first & 0x3f {
                0 => 64 + u32::from(self.u8().await?),
                1 => 64 + u32::from(self.u8().await?) + 256 * u32::from(self.u8().await?),
                n => u32::from(n),
            };
            let mut state = self.streams.get(&csid).cloned().unwrap_or_default();
            let starting = state.payload.is_empty();
            if fmt <= 2 {
                let ts = self.be(3).await?;
                if fmt <= 1 {
                    state.length = self.be(3).await?;
                    state.kind = self.u8().await?;
                    if fmt == 0 {
                        let mut le = [0u8; 4];
                        self.io.read_exact(&mut le).await?;
                        state.stream = u32::from_le_bytes(le);
                    }
                }
                state.extended = ts == 0xFF_FFFF;
                let ts = if state.extended { self.be(4).await? } else { ts };
                if fmt == 0 {
                    state.timestamp = ts;
                    state.delta = 0;
                } else {
                    state.delta = ts;
                    state.timestamp = state.timestamp.wrapping_add(ts);
                }
            } else {
                if state.extended {
                    self.be(4).await?;
                }
                if starting {
                    state.timestamp = state.timestamp.wrapping_add(state.delta);
                }
            }
            if state.length > MAX_MESSAGE {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "сообщение слишком большое"));
            }
            let want = (state.length as usize - state.payload.len()).min(self.chunk_size as usize);
            let mut piece = vec![0u8; want];
            self.io.read_exact(&mut piece).await?;
            state.payload.extend_from_slice(&piece);
            if state.payload.len() < state.length as usize {
                self.streams.insert(csid, state);
                continue;
            }
            let message = Message { kind: state.kind, stream: state.stream, timestamp: state.timestamp, payload: std::mem::take(&mut state.payload) };
            self.streams.insert(csid, state);
            if message.kind == TYPE_SET_CHUNK_SIZE && message.payload.len() >= 4 {
                self.chunk_size = (u32::from_be_bytes(message.payload[..4].try_into().unwrap_or_default()) & 0x7fff_ffff).clamp(1, MAX_MESSAGE);
            }
            return Ok(message);
        }
    }
}

// ---- FLV payloads.

/// An H.264 frame as a video message body: `avcc` are length-prefixed NAL units (WebCodecs' «avc» format).
pub fn video_body(key: bool, avcc: &[u8]) -> Vec<u8> {
    let mut body = vec![if key { 0x17 } else { 0x27 }, 1, 0, 0, 0];
    body.extend_from_slice(avcc);
    body
}

/// The AVC decoder configuration record (WebCodecs' description) as the video sequence header.
pub fn video_header(avc_config: &[u8]) -> Vec<u8> {
    let mut body = vec![0x17, 0, 0, 0, 0];
    body.extend_from_slice(avc_config);
    body
}

/// Enhanced RTMP's FourCC of AV1.
const AV1_FOURCC: &[u8; 4] = b"av01";
/// As `videocodecid` of the metadata: the FourCC read as a number.
const AV1_CODEC_ID: f64 = 1_635_135_537.0;

/// The AV1CodecConfigurationRecord as Enhanced RTMP's sequence start (an extended header: key frame, packet type 0).
pub fn av1_header(av1c: &[u8]) -> Vec<u8> {
    let mut body = vec![0x90];
    body.extend_from_slice(AV1_FOURCC);
    body.extend_from_slice(av1c);
    body
}

/// An AV1 frame as Enhanced RTMP's coded frames (packet type 1, no composition time for AV1), its temporal
/// delimiters left out as the ISO binding of AV1 wants.
pub fn av1_body(key: bool, obus: &[u8]) -> Vec<u8> {
    let mut body = vec![if key { 0x91 } else { 0xA1 }];
    body.extend_from_slice(AV1_FOURCC);
    body.extend_from_slice(&without_temporal_delimiters(obus));
    body
}

/// AV1 OBUs (low-overhead format) without temporal delimiters (type 2); what cannot be read is kept as it is.
pub fn without_temporal_delimiters(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut at = 0;
    while at < data.len() {
        let start = at;
        let header = data[at];
        let kind = (header >> 3) & 0x0f;
        let extension = usize::from((header >> 2) & 1);
        let sized = (header >> 1) & 1 == 1;
        at += 1 + extension;
        let mut size = data.len().saturating_sub(at);
        if sized {
            size = 0;
            for i in 0..8 {
                let Some(&byte) = data.get(at) else {
                    out.extend_from_slice(&data[start..]);
                    return out;
                };
                at += 1;
                size |= usize::from(byte & 0x7f) << (7 * i);
                if byte & 0x80 == 0 {
                    break;
                }
            }
        }
        let end = at.saturating_add(size);
        if end > data.len() {
            out.extend_from_slice(&data[start..]);
            return out;
        }
        if kind != 2 {
            out.extend_from_slice(&data[start..end]);
        }
        at = end;
    }
    out
}

/// A raw AAC frame as an audio message body (AAC, 44 kHz flag, 16-bit, stereo, as FLV wants for any AAC).
pub fn audio_body(aac: &[u8]) -> Vec<u8> {
    let mut body = vec![0xAF, 1];
    body.extend_from_slice(aac);
    body
}

/// The AudioSpecificConfig as the audio sequence header.
pub fn audio_header(asc: &[u8]) -> Vec<u8> {
    let mut body = vec![0xAF, 0];
    body.extend_from_slice(asc);
    body
}

// ---- The publisher.

#[derive(Debug)]
pub enum RtmpError {
    Io(std::io::Error),
    Refused(String),
}

impl std::fmt::Display for RtmpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RtmpError::Io(e) => write!(f, "связь: {e}"),
            RtmpError::Refused(why) => write!(f, "сервер не принял: {why}"),
        }
    }
}

impl From<std::io::Error> for RtmpError {
    fn from(e: std::io::Error) -> Self {
        RtmpError::Io(e)
    }
}

/// What the stream is, for the server's «onMetaData».
#[derive(Debug, Clone, Copy)]
pub struct StreamInfo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
    /// The video is AV1, sent as Enhanced RTMP; H.264 otherwise.
    pub av1: bool,
}

/// The sending side of a published stream.
pub struct Publisher<W> {
    io: W,
    stream: u32,
}

/// Does the simple handshake on `io`.
async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(io: &mut S) -> std::io::Result<()> {
    let mut c1 = vec![0u8; HANDSHAKE_SIZE];
    let random: [u8; 32] = hv_roster::keys::random_bytes().unwrap_or([7; 32]);
    for (i, b) in c1.iter_mut().enumerate().skip(8) {
        *b = random[i % 32] ^ (i as u8);
    }
    io.write_all(&[3]).await?;
    io.write_all(&c1).await?;
    io.flush().await?;
    let mut s0s1 = vec![0u8; 1 + HANDSHAKE_SIZE];
    io.read_exact(&mut s0s1).await?;
    let mut s2 = vec![0u8; HANDSHAKE_SIZE];
    io.read_exact(&mut s2).await?;
    io.write_all(&s0s1[1..]).await?;
    io.flush().await
}

fn command(name: &str, transaction: f64, args: &[Amf]) -> Vec<u8> {
    let mut values = vec![Amf::Str(name.into()), Amf::Number(transaction)];
    values.extend_from_slice(args);
    encode(&values)
}

async fn send<W: AsyncWrite + Unpin>(io: &mut W, csid: u32, message: Message) -> std::io::Result<()> {
    io.write_all(&chunks(csid, &message, CHUNK_SIZE)).await
}

/// Waits for the answer (`_result`/`_error`) to `transaction`, or an `onStatus`, skipping all else.
async fn answer<R: AsyncRead + Unpin>(reader: &mut ChunkReader<R>, transaction: Option<f64>) -> Result<Vec<Amf>, RtmpError> {
    for _ in 0..64 {
        let message = reader.next().await?;
        if message.kind != TYPE_COMMAND {
            continue;
        }
        let values = decode(&message.payload);
        let name = values.first().and_then(Amf::as_str).unwrap_or_default();
        let number = values.get(1).and_then(Amf::as_number);
        match (name, transaction) {
            ("_result", Some(t)) if number == Some(t) => return Ok(values),
            ("_error", Some(t)) if number == Some(t) => {
                let why = values.get(3).and_then(|o| o.get("description")).and_then(Amf::as_str).unwrap_or("ошибка");
                return Err(RtmpError::Refused(why.into()));
            }
            ("onStatus", None) => return Ok(values),
            _ => {}
        }
    }
    Err(RtmpError::Refused("сервер не ответил".into()))
}

/// Connects to `endpoint` over `io` (already TCP or TLS) and publishes `key`. The reading half goes back to the caller
/// to keep reading what the server says (pings, the end).
pub async fn publish<R, W>(reader: &mut ChunkReader<R>, mut io: W, endpoint: &Endpoint, key: &str, info: StreamInfo) -> Result<Publisher<W>, RtmpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    send(&mut io, CSID_CONTROL, Message { kind: TYPE_SET_CHUNK_SIZE, stream: 0, timestamp: 0, payload: CHUNK_SIZE.to_be_bytes().to_vec() }).await?;
    let mut props = vec![
        ("app".into(), Amf::Str(endpoint.app.clone())),
        ("type".into(), Amf::Str("nonprivate".into())),
        ("flashVer".into(), Amf::Str("FMLE/3.0 (compatible; HataVoice)".into())),
        ("tcUrl".into(), Amf::Str(endpoint.tc_url.clone())),
    ];
    // Enhanced RTMP: the codecs beyond the old FLV ones that this stream brings.
    if info.av1 {
        props.push(("fourCcList".into(), Amf::Array(vec![Amf::Str("av01".into())])));
    }
    let connect = Amf::Object(props);
    send(&mut io, CSID_COMMAND, Message { kind: TYPE_COMMAND, stream: 0, timestamp: 0, payload: command("connect", 1.0, &[connect]) }).await?;
    io.flush().await?;
    answer(reader, Some(1.0)).await?;
    for (name, t) in [("releaseStream", 2.0), ("FCPublish", 3.0)] {
        send(&mut io, CSID_COMMAND, Message { kind: TYPE_COMMAND, stream: 0, timestamp: 0, payload: command(name, t, &[Amf::Null, Amf::Str(key.into())]) }).await?;
    }
    send(&mut io, CSID_COMMAND, Message { kind: TYPE_COMMAND, stream: 0, timestamp: 0, payload: command("createStream", 4.0, &[Amf::Null]) }).await?;
    io.flush().await?;
    let created = answer(reader, Some(4.0)).await?;
    let stream = created.get(3).and_then(Amf::as_number).unwrap_or(1.0) as u32;
    let publishing = command("publish", 5.0, &[Amf::Null, Amf::Str(key.into()), Amf::Str("live".into())]);
    send(&mut io, CSID_COMMAND, Message { kind: TYPE_COMMAND, stream, timestamp: 0, payload: publishing }).await?;
    io.flush().await?;
    let status = answer(reader, None).await?;
    let code = status.get(3).and_then(|o| o.get("code")).and_then(Amf::as_str).unwrap_or_default().to_string();
    if code != "NetStream.Publish.Start" {
        let why = status.get(3).and_then(|o| o.get("description")).and_then(Amf::as_str).unwrap_or(&code).to_string();
        return Err(RtmpError::Refused(why));
    }
    let mut publisher = Publisher { io, stream };
    publisher.metadata(info).await?;
    Ok(publisher)
}

/// Opens a connection to `endpoint`: TCP, wrapped in TLS for `rtmps://`, the handshake done.
pub async fn dial(endpoint: &Endpoint) -> Result<Box<dyn Duplex>, RtmpError> {
    let tcp = tokio::net::TcpStream::connect((endpoint.host.as_str(), endpoint.port)).await?;
    let _ = tcp.set_nodelay(true);
    let mut io: Box<dyn Duplex> = if endpoint.tls {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| RtmpError::Refused(e.to_string()))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(endpoint.host.clone()).map_err(|e| RtmpError::Refused(e.to_string()))?;
        Box::new(tokio_rustls::TlsConnector::from(std::sync::Arc::new(config)).connect(name, tcp).await?)
    } else {
        Box::new(tcp)
    };
    handshake(&mut io).await?;
    Ok(io)
}

/// A connection that reads and writes.
pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

impl<W: AsyncWrite + Unpin> Publisher<W> {
    async fn metadata(&mut self, info: StreamInfo) -> std::io::Result<()> {
        let n = |x: u32| Amf::Number(f64::from(x));
        let meta = Amf::Object(vec![
            ("width".into(), n(info.width)),
            ("height".into(), n(info.height)),
            ("framerate".into(), n(info.fps)),
            ("videocodecid".into(), if info.av1 { Amf::Number(AV1_CODEC_ID) } else { n(7) }),
            ("videodatarate".into(), n(info.video_kbps)),
            ("audiocodecid".into(), n(10)),
            ("audiodatarate".into(), n(info.audio_kbps)),
            ("audiosamplerate".into(), n(48_000)),
            ("audiochannels".into(), n(2)),
            ("encoder".into(), Amf::Str("HataVoice".into())),
        ]);
        let payload = encode(&[Amf::Str("@setDataFrame".into()), Amf::Str("onMetaData".into()), meta]);
        send(&mut self.io, CSID_COMMAND, Message { kind: TYPE_DATA, stream: self.stream, timestamp: 0, payload }).await?;
        self.io.flush().await
    }

    pub async fn video(&mut self, timestamp: u32, body: Vec<u8>) -> std::io::Result<()> {
        send(&mut self.io, CSID_VIDEO, Message { kind: TYPE_VIDEO, stream: self.stream, timestamp, payload: body }).await?;
        self.io.flush().await
    }

    pub async fn audio(&mut self, timestamp: u32, body: Vec<u8>) -> std::io::Result<()> {
        send(&mut self.io, CSID_AUDIO, Message { kind: TYPE_AUDIO, stream: self.stream, timestamp, payload: body }).await?;
        self.io.flush().await
    }

    /// A ping of the server's, answered.
    pub async fn pong(&mut self, payload: &[u8]) -> std::io::Result<()> {
        if payload.len() < 6 || payload[..2] != [0, 6] {
            return Ok(());
        }
        let mut answer = vec![0, 7];
        answer.extend_from_slice(&payload[2..6]);
        send(&mut self.io, CSID_CONTROL, Message { kind: TYPE_USER_CONTROL, stream: 0, timestamp: 0, payload: answer }).await?;
        self.io.flush().await
    }

    /// Says we are done, politely.
    pub async fn close(mut self) {
        let payload = command("deleteStream", 6.0, &[Amf::Null, Amf::Number(f64::from(self.stream))]);
        let _ = send(&mut self.io, CSID_COMMAND, Message { kind: TYPE_COMMAND, stream: 0, timestamp: 0, payload }).await;
        let _ = self.io.flush().await;
        let _ = self.io.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_of_streaming_services() {
        assert_eq!(
            parse_url("rtmps://live.twitch.tv:443/app"),
            Some(Endpoint { tls: true, host: "live.twitch.tv".into(), port: 443, app: "app".into(), tc_url: "rtmps://live.twitch.tv:443/app".into() })
        );
        assert_eq!(parse_url("rtmp://a.rtmp.youtube.com/live2").map(|e| (e.port, e.app)), Some((1935, "live2".into())));
        assert_eq!(parse_url("rtmps://x.example/live/").map(|e| (e.port, e.app)), Some((443, "live".into())));
        for bad in ["http://x/app", "rtmp://x", "rtmp:///app", "rtmp://x:99999/app", "rtmp://x/ap p", "rtmp://x/"] {
            assert_eq!(parse_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn amf_goes_there_and_back() {
        let values = vec![Amf::Str("_result".into()), Amf::Number(4.0), Amf::Null, Amf::Number(1.0), Amf::Object(vec![("code".into(), Amf::Str("x".into())), ("ok".into(), Amf::Bool(true))])];
        assert_eq!(decode(&encode(&values)), values);
        assert_eq!(decode(&[0x02, 0x00]), Vec::<Amf>::new(), "a cut string ends the list");
    }

    #[tokio::test]
    async fn chunks_are_read_back_whole() {
        let big = Message { kind: TYPE_VIDEO, stream: 1, timestamp: 0x0100_0000, payload: (0..10_000u32).map(|i| i as u8).collect() };
        let small = Message { kind: TYPE_COMMAND, stream: 0, timestamp: 5, payload: b"hello".to_vec() };
        let set = Message { kind: TYPE_SET_CHUNK_SIZE, stream: 0, timestamp: 0, payload: 4096u32.to_be_bytes().to_vec() };
        let mut bytes = chunks(2, &set, 128);
        bytes.extend(chunks(6, &big, 4096));
        bytes.extend(chunks(70, &small, 4096));
        let mut reader = ChunkReader::new(bytes.as_slice());
        assert_eq!(reader.next().await.unwrap(), set);
        assert_eq!(reader.next().await.unwrap(), big, "an extended timestamp, three chunks");
        assert_eq!(reader.next().await.unwrap(), small, "a two-byte chunk stream id");
    }

    /// A tiny RTMP server: the handshake, answers to a publisher, and the media it then gets.
    async fn fake_server(listener: tokio::net::TcpListener, refuse: bool) -> Vec<Message> {
        let (socket, _) = listener.accept().await.unwrap();
        let (read, mut write) = tokio::io::split(socket);
        let mut read = read;
        let mut c0c1 = vec![0u8; 1 + HANDSHAKE_SIZE];
        read.read_exact(&mut c0c1).await.unwrap();
        write.write_all(&[3]).await.unwrap();
        write.write_all(&[9u8; HANDSHAKE_SIZE]).await.unwrap();
        write.write_all(&c0c1[1..]).await.unwrap();
        let mut c2 = vec![0u8; HANDSHAKE_SIZE];
        read.read_exact(&mut c2).await.unwrap();
        assert_eq!(c2, vec![9u8; HANDSHAKE_SIZE], "C2 echoes S1");
        let mut reader = ChunkReader::new(read);
        let mut media = Vec::new();
        loop {
            let Ok(message) = reader.next().await else { return media };
            if message.kind != TYPE_COMMAND {
                if message.kind == TYPE_AUDIO || message.kind == TYPE_VIDEO || message.kind == TYPE_DATA {
                    media.push(message);
                }
                continue;
            }
            let values = decode(&message.payload);
            let (name, t) = (values[0].as_str().unwrap().to_string(), values[1].as_number().unwrap());
            let reply = match name.as_str() {
                "connect" => {
                    assert_eq!(values[2].get("app").and_then(Amf::as_str), Some("app"));
                    Some(command("_result", t, &[Amf::Null, Amf::Object(vec![("code".into(), Amf::Str("NetConnection.Connect.Success".into()))])]))
                }
                "createStream" => Some(command("_result", t, &[Amf::Null, Amf::Number(7.0)])),
                "publish" => {
                    assert_eq!(message.stream, 7);
                    assert_eq!(values[3].as_str(), Some("live_secret"));
                    let code = if refuse { "NetStream.Publish.BadName" } else { "NetStream.Publish.Start" };
                    Some(command("onStatus", 0.0, &[Amf::Null, Amf::Object(vec![("code".into(), Amf::Str(code.into())), ("description".into(), Amf::Str("ключ не тот".into()))])]))
                }
                _ => None,
            };
            if let Some(payload) = reply {
                write.write_all(&chunks(3, &Message { kind: TYPE_COMMAND, stream: 0, timestamp: 0, payload }, 128)).await.unwrap();
            }
        }
    }

    fn info() -> StreamInfo {
        StreamInfo { width: 1920, height: 1080, fps: 60, video_kbps: 6000, audio_kbps: 160, av1: false }
    }

    #[test]
    fn av1_goes_as_enhanced_rtmp_without_temporal_delimiters() {
        let header = av1_header(&[0x81, 0x09, 0x0c, 0x00]);
        assert_eq!(&header[..5], &[0x90, b'a', b'v', b'0', b'1'], "an extended header: key frame, sequence start, av01");
        assert_eq!(&header[5..], &[0x81, 0x09, 0x0c, 0x00]);
        // A temporal delimiter, a sequence header and a frame OBU: the delimiter goes.
        let frame = [0x12, 0x00, 0x0a, 0x01, 0xff, 0x32, 0x02, 0xaa, 0xbb];
        let key = av1_body(true, &frame);
        assert_eq!(&key[..5], &[0x91, b'a', b'v', b'0', b'1'], "coded frames, a key one, no composition time");
        assert_eq!(&key[5..], &[0x0a, 0x01, 0xff, 0x32, 0x02, 0xaa, 0xbb]);
        assert_eq!(av1_body(false, &[0x32, 0x00])[0], 0xA1);
        // What cannot be read is kept, not lost.
        assert_eq!(without_temporal_delimiters(&[0x32, 0x09, 0x01]), vec![0x32, 0x09, 0x01]);
    }

    #[test]
    fn a_strict_array_goes_there_and_back() {
        let list = Amf::Array(vec![Amf::Str("av01".into())]);
        assert_eq!(decode(&encode(std::slice::from_ref(&list))), vec![list]);
    }

    #[tokio::test]
    async fn a_stream_is_published_with_its_headers_and_frames() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(fake_server(listener, false));
        let endpoint = parse_url(&format!("rtmp://127.0.0.1:{port}/app")).unwrap();
        let io = dial(&endpoint).await.unwrap();
        let (read, write) = tokio::io::split(io);
        let mut reader = ChunkReader::new(read);
        let mut publisher = publish(&mut reader, write, &endpoint, "live_secret", info()).await.unwrap();
        publisher.video(0, video_header(&[1, 0x64, 0, 0x2a])).await.unwrap();
        publisher.audio(0, audio_header(&[0x11, 0x90])).await.unwrap();
        publisher.video(0, video_body(true, &[0, 0, 0, 1, 0x65])).await.unwrap();
        publisher.audio(21, audio_body(&[0x21, 0x10])).await.unwrap();
        publisher.video(16, video_body(false, &[0, 0, 0, 1, 0x41])).await.unwrap();
        publisher.close().await;
        let media = server.await.unwrap();
        let kinds: Vec<(u8, u32, Vec<u8>)> = media.iter().map(|m| (m.kind, m.timestamp, m.payload.iter().take(2).copied().collect())).collect();
        assert_eq!(kinds[0].0, TYPE_DATA, "onMetaData first");
        assert_eq!(&kinds[1..], &[
            (TYPE_VIDEO, 0, vec![0x17, 0]),
            (TYPE_AUDIO, 0, vec![0xAF, 0]),
            (TYPE_VIDEO, 0, vec![0x17, 1]),
            (TYPE_AUDIO, 21, vec![0xAF, 1]),
            (TYPE_VIDEO, 16, vec![0x27, 1]),
        ]);
        assert!(media.iter().all(|m| m.stream == 7));
    }

    #[tokio::test]
    async fn a_refused_key_says_why() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _server = tokio::spawn(fake_server(listener, true));
        let endpoint = parse_url(&format!("rtmp://127.0.0.1:{port}/app")).unwrap();
        let (read, write) = tokio::io::split(dial(&endpoint).await.unwrap());
        let mut reader = ChunkReader::new(read);
        let refused = publish(&mut reader, write, &endpoint, "live_secret", info()).await.err().unwrap();
        assert_eq!(refused.to_string(), "сервер не принял: ключ не тот");
    }
}
