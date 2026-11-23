//! Child processes that must not outlive us (LiveKit under the server, the server under the client).

/// Ties `child` to the current process: when this process exits for any reason, even a crash or
/// being killed from Task Manager, Windows kills the child too.
#[cfg(windows)]
pub fn kill_with_this_process(child: std::os::windows::io::RawHandle) -> Result<(), String> {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };

    // The job handle is deliberately never closed: the OS closes it when we exit, which
    // triggers KILL_ON_JOB_CLOSE for every process in the job.
    static JOB: OnceLock<Result<usize, String>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObject: {e}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| format!("SetInformationJobObject: {e}"))?;
        Ok(job.0 as usize)
    });
    let job = HANDLE(*job.as_ref().map_err(Clone::clone)? as *mut core::ffi::c_void);
    // SAFETY: both handles are valid for the duration of the call.
    unsafe { AssignProcessToJobObject(job, HANDLE(child)) }
        .map_err(|e| format!("AssignProcessToJobObject: {e}"))
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use std::os::windows::io::AsRawHandle;

    use super::*;

    #[test]
    fn a_child_can_be_tied_to_this_process() {
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 5 127.0.0.1 > nul"])
            .spawn()
            .unwrap();
        kill_with_this_process(child.as_raw_handle()).unwrap();
        // A second child goes into the same job.
        let mut second = std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().unwrap();
        kill_with_this_process(second.as_raw_handle()).unwrap();
        assert!(child.try_wait().unwrap().is_none(), "tying must not kill the child");
        let _ = second.wait();
        child.kill().unwrap();
        let _ = child.wait();
    }
}
