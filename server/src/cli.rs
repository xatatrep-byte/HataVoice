use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Cli {
    /// Host mode: keep config, keys and logs here and run LiveKit as a child.
    pub data_dir: Option<PathBuf>,
    /// livekit-server executable; defaults to the one next to hatavoice-server.
    pub livekit_bin: Option<PathBuf>,
}

/// Parses `--data-dir <dir>` and `--livekit-bin <path>`; anything else is an error.
pub fn parse(args: &[String]) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let slot = match flag.as_str() {
            "--data-dir" => &mut cli.data_dir,
            "--livekit-bin" => &mut cli.livekit_bin,
            other => return Err(format!("unknown argument {other:?}; expected --data-dir or --livekit-bin")),
        };
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        *slot = Some(PathBuf::from(value));
    }
    Ok(cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_means_dev_mode() {
        assert_eq!(parse(&args(&[])), Ok(Cli::default()));
    }

    #[test]
    fn host_mode_flags_in_any_order() {
        let cli = parse(&args(&["--livekit-bin", "C:\\lk\\livekit-server.exe", "--data-dir", "C:\\data dir"])).unwrap();
        assert_eq!(cli.data_dir, Some(PathBuf::from("C:\\data dir")));
        assert_eq!(cli.livekit_bin, Some(PathBuf::from("C:\\lk\\livekit-server.exe")));
    }

    #[test]
    fn missing_values_and_unknown_flags_are_errors() {
        assert!(parse(&args(&["--data-dir"])).is_err());
        assert!(parse(&args(&["--port", "1"])).is_err());
    }
}
