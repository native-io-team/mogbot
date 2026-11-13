//! Windows only: the link's named pipe and Chrome's registry.
//!
//! - **The pipe** is the Unix socket's stand-in: `\\.\pipe\<slug>-chrome-link-<hash>`,
//!   created with a protected DACL that admits only this user's SID (no
//!   Everyone, no Administrators, no SYSTEM), remote clients rejected, and
//!   the first instance claimed exclusively so a second copy of the app (or
//!   anything squatting on the name) makes start fail rather than share it.
//!   Every client's process is checked to run as this user ([`peer_is_this_user`]),
//!   the second wall the socket's `peer_cred` is on Unix. The token proof
//!   still runs both ways on top: a squatter that took the name first learns
//!   nothing and relays nothing.
//! - **The registry**: Chrome on Windows finds a native host through
//!   `HKCU\Software\<vendor>\NativeMessagingHosts\<name>`, whose default
//!   value is the manifest's path. Chrome, Chromium and Edge each have one.
//!   Only HKCU is written; HKLM (this PC's Chrome policy) is only read.

use std::ffi::c_void;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegEnumValueW, RegGetValueW, RegOpenKeyExW,
    RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE,
    REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` for the host's open of
/// the pipe: the app may learn who connected, never act as them. (std adds
/// `SECURITY_SQOS_PRESENT` itself; this is `SecurityIdentification << 16`.)
pub const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

/// `ERROR_PIPE_BUSY`: every instance is taken for a moment; try again.
pub const ERROR_PIPE_BUSY: i32 = 231;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/* --------------------------------------------------------------- users */

/// The SID of `token`'s user, as bytes.
fn token_user_sid(token: HANDLE) -> Option<Vec<u8>> {
    let mut len = 0u32;
    // SAFETY: a size query with no buffer; `len` is written.
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len) };
    if len == 0 {
        return None;
    }
    // u64s so the TOKEN_USER at the front is aligned.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `len` bytes.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr().cast::<c_void>(),
            len,
            &mut len,
        )
    };
    if ok == 0 {
        return None;
    }
    // SAFETY: the call above wrote a TOKEN_USER at the front of `buf`, whose
    // SID points inside `buf`, which outlives this read.
    unsafe {
        let user = &*(buf.as_ptr().cast::<TOKEN_USER>());
        let sid = user.User.Sid;
        let n = GetLengthSid(sid) as usize;
        Some(std::slice::from_raw_parts(sid.cast::<u8>(), n).to_vec())
    }
}

/// The user SID a process runs as.
fn process_user_sid(pid: Option<u32>) -> Option<Vec<u8>> {
    // SAFETY: handles opened here are closed here; the pseudo handle of
    // GetCurrentProcess needs no closing.
    unsafe {
        let process = match pid {
            None => GetCurrentProcess(),
            Some(pid) => {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    return None;
                }
                h
            }
        };
        let mut token: HANDLE = null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0;
        let sid = if opened { token_user_sid(token) } else { None };
        if opened {
            CloseHandle(token);
        }
        if pid.is_some() {
            CloseHandle(process);
        }
        sid
    }
}

/// This process's user SID in SDDL form (`S-1-5-21-…`).
fn this_user_sid_string() -> io::Result<String> {
    let mut sid =
        process_user_sid(None).ok_or_else(|| io::Error::other("couldn't read this user's SID"))?;
    let mut out: *mut u16 = null_mut();
    // SAFETY: `sid` is a valid SID; `out` is freed with LocalFree below.
    unsafe {
        if ConvertSidToStringSidW(sid.as_mut_ptr().cast::<c_void>(), &mut out) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0;
        while *out.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(out, n));
        LocalFree(out.cast::<c_void>());
        Ok(s)
    }
}

/// The pipe's other end (a client's process for the app, the server's for
/// the host) runs as this user.
pub fn peer_is_this_user(pipe: &impl AsRawHandle, peer_is_client: bool) -> bool {
    let handle = pipe.as_raw_handle() as HANDLE;
    let mut pid = 0u32;
    // SAFETY: `handle` is a live pipe handle; `pid` is written.
    let ok = unsafe {
        if peer_is_client {
            GetNamedPipeClientProcessId(handle, &mut pid)
        } else {
            GetNamedPipeServerProcessId(handle, &mut pid)
        }
    };
    if ok == 0 {
        return false;
    }
    match (process_user_sid(Some(pid)), process_user_sid(None)) {
        (Some(peer), Some(me)) => peer == me,
        _ => false,
    }
}

/* ---------------------------------------------------------------- pipe */

/// Security attributes admitting only this user: a protected DACL with one
/// entry, generic all for this user's SID.
pub struct PipeSecurity {
    sd: PSECURITY_DESCRIPTOR,
    attrs: Box<SECURITY_ATTRIBUTES>,
}

// SAFETY: the descriptor is immutable once built and only read by
// CreateNamedPipeW; it is freed once, on drop.
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    pub fn this_user_only() -> io::Result<PipeSecurity> {
        let sddl = wide(&format!("D:P(A;;GA;;;{})", this_user_sid_string()?));
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: `sddl` is NUL-terminated; `sd` is freed on drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let attrs = Box::new(SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        });
        Ok(PipeSecurity { sd, attrs })
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        // SAFETY: `sd` came from ConvertStringSecurityDescriptor…, freed once.
        unsafe { LocalFree(self.sd) };
    }
}

/// One instance of the link's pipe, admitting only this user. `first`: the
/// app claims the name; failing that, someone else holds it.
pub fn create_pipe(
    name: &str,
    security: &PipeSecurity,
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    let mut opts = tokio::net::windows::named_pipe::ServerOptions::new();
    opts.first_pipe_instance(first)
        .reject_remote_clients(true)
        .access_inbound(true)
        .access_outbound(true)
        .pipe_mode(tokio::net::windows::named_pipe::PipeMode::Byte);
    let attrs: *const SECURITY_ATTRIBUTES = &*security.attrs;
    // SAFETY: `attrs` points at a SECURITY_ATTRIBUTES whose descriptor lives
    // as long as `security`, which outlives this call.
    unsafe { opts.create_with_security_attributes_raw(name, attrs as *mut c_void) }
}

/* ------------------------------------------------------------ registry */

/// A registry root.
#[derive(Clone, Copy)]
pub enum Root {
    User,
    Machine,
}

fn hkey(root: Root) -> HKEY {
    match root {
        Root::User => HKEY_CURRENT_USER,
        Root::Machine => HKEY_LOCAL_MACHINE,
    }
}

fn check(code: u32) -> io::Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

/// Set `subkey`'s value `name` (`None`: its default value) to `value`,
/// creating the key.
pub fn set_string(root: Root, subkey: &str, name: Option<&str>, value: &str) -> io::Result<()> {
    let sub = wide(subkey);
    let name = name.map(wide);
    let data = wide(value);
    let mut key: HKEY = null_mut();
    // SAFETY: NUL-terminated strings; `key` is closed below.
    unsafe {
        check(RegCreateKeyExW(
            hkey(root),
            sub.as_ptr(),
            0,
            null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            null_mut(),
            &mut key,
            null_mut(),
        ))?;
        let r = check(RegSetValueExW(
            key,
            name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr()),
            0,
            REG_SZ,
            data.as_ptr().cast::<u8>(),
            (data.len() * 2) as u32,
        ));
        RegCloseKey(key);
        r
    }
}

/// `subkey`'s string value `name` (`None`: its default value).
pub fn get_string(root: Root, subkey: &str, name: Option<&str>) -> Option<String> {
    let sub = wide(subkey);
    let name = name.map(wide);
    let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());
    let mut len = 0u32;
    // SAFETY: a size query, then a read into a buffer of that size.
    unsafe {
        if RegGetValueW(
            hkey(root),
            sub.as_ptr(),
            name_ptr,
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut len,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(
            hkey(root),
            sub.as_ptr(),
            name_ptr,
            RRF_RT_REG_SZ,
            null_mut(),
            buf.as_mut_ptr().cast::<c_void>(),
            &mut len,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// `subkey`'s DWORD value `name`.
pub fn get_dword(root: Root, subkey: &str, name: &str) -> Option<u32> {
    let sub = wide(subkey);
    let name = wide(name);
    let mut v = 0u32;
    let mut len = 4u32;
    // SAFETY: a DWORD read into `v`.
    let r = unsafe {
        RegGetValueW(
            hkey(root),
            sub.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut v as *mut u32).cast::<c_void>(),
            &mut len,
        )
    };
    (r == ERROR_SUCCESS).then_some(v)
}

/// Every string value under `subkey` (Chrome's list policies: values
/// named "1", "2", …), in the registry's order.
pub fn string_values(root: Root, subkey: &str) -> Vec<String> {
    let sub = wide(subkey);
    let mut key: HKEY = null_mut();
    let mut out = Vec::new();
    // SAFETY: `key` is closed below; buffers are sized for each call.
    unsafe {
        if RegOpenKeyExW(hkey(root), sub.as_ptr(), 0, KEY_READ, &mut key) != ERROR_SUCCESS {
            return out;
        }
        for i in 0.. {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            let mut data = vec![0u16; 4096];
            let mut data_len = (data.len() * 2) as u32;
            let mut kind = 0u32;
            let r = RegEnumValueW(
                key,
                i,
                name.as_mut_ptr(),
                &mut name_len,
                null_mut(),
                &mut kind,
                data.as_mut_ptr().cast::<u8>(),
                &mut data_len,
            );
            if r != ERROR_SUCCESS {
                break;
            }
            if kind == REG_SZ {
                let n = (data_len as usize / 2).min(data.len());
                let end = data[..n].iter().position(|&c| c == 0).unwrap_or(n);
                out.push(String::from_utf16_lossy(&data[..end]));
            }
        }
        RegCloseKey(key);
    }
    out
}

/// Remove `subkey` and everything under it. Gone already is fine.
pub fn delete_tree(root: Root, subkey: &str) -> io::Result<()> {
    let sub = wide(subkey);
    // SAFETY: a NUL-terminated key path.
    let r = unsafe { RegDeleteTreeW(hkey(root), sub.as_ptr()) };
    if r == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    check(r)
}
