//! The publisher's tool. `keygen <key file>` makes the release key once and prints its public half for
//! `packaging/release.pub`; `seal <key file> <installer> <version>` writes the version and signature at the installer's end;
//! `seal-apart <key file> <package> <version> <seal file>` writes a package's seal into a file of its own (an Android APK
//! cannot carry one at its end: its own signature covers the whole file).

use hv_roster::keys::Identity;
use hv_roster::release;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_key(path: &str) -> Result<Identity, String> {
    let seed = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let seed: [u8; 32] = seed.try_into().map_err(|_| format!("{path}: not a key"))?;
    Ok(Identity::from_seed(seed))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["keygen", path] => {
            if std::path::Path::new(path).exists() {
                return Err(format!("{path} exists already: a new key would make every installed copy refuse updates"));
            }
            let key = Identity::generate()?;
            if let Some(dir) = std::path::Path::new(path).parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(path, key.seed()).map_err(|e| e.to_string())?;
            println!("{}", hex(&key.public().0));
            Ok(())
        }
        ["seal", key, installer, version] => {
            let key = read_key(key)?;
            let bytes = std::fs::read(installer).map_err(|e| format!("{installer}: {e}"))?;
            let sealed = release::seal(&bytes, version, &key)?;
            std::fs::write(installer, sealed).map_err(|e| e.to_string())?;
            println!("sealed {installer} as {version}");
            Ok(())
        }
        ["seal-apart", key, package, version, out] => {
            let key = read_key(key)?;
            let bytes = std::fs::read(package).map_err(|e| format!("{package}: {e}"))?;
            std::fs::write(out, release::seal_digest(&bytes, version, &key)?).map_err(|e| e.to_string())?;
            println!("sealed {package} as {version} in {out}");
            Ok(())
        }
        _ => Err("usage: seal_release keygen <key> | seal <key> <installer> <version> | seal-apart <key> <package> <version> <seal>".into()),
    }
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            std::process::ExitCode::FAILURE
        }
    }
}
