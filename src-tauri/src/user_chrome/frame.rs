//! Framing: Chrome's native messaging format, used on both legs.
//!
//! Each message is a 32-bit length in the machine's own byte order, then
//! that many bytes of UTF-8 JSON (Chrome's rule for native hosts). The app's
//! socket uses the same frames, so the host relays without re-encoding.
//!
//! Limits are Chrome's: a message to Chrome may be at most 1 MiB
//! ([`MAX_TO_CHROME`]); one from Chrome at most 64 MiB ([`MAX_FROM_CHROME`]).
//! The app only ever sends small requests; screenshots and page trees come
//! the other way.

use std::io::{self, Read, Write};

/// The most a native host may send Chrome in one message.
pub const MAX_TO_CHROME: usize = 1024 * 1024;
/// The most Chrome sends a native host in one message.
pub const MAX_FROM_CHROME: usize = 64 * 1024 * 1024;

/// Why a frame couldn't be read.
#[derive(Debug)]
pub enum FrameError {
    /// The other side closed cleanly between frames.
    Closed,
    /// A length over the limit (or zero): the stream is not ours.
    TooLong(usize),
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Closed => write!(f, "closed"),
            FrameError::TooLong(n) => write!(f, "a {n}-byte frame is over the limit"),
            FrameError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        FrameError::Io(e)
    }
}

/// The 4-byte header for a body of `len` bytes.
pub fn header(len: usize) -> [u8; 4] {
    (len as u32).to_ne_bytes()
}

/// A body's length from its header, checked against `max`.
pub fn length(header: [u8; 4], max: usize) -> Result<usize, FrameError> {
    let n = u32::from_ne_bytes(header) as usize;
    if n == 0 || n > max {
        return Err(FrameError::TooLong(n));
    }
    Ok(n)
}

/// One whole frame: header and body.
pub fn encode(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&header(body.len()));
    out.extend_from_slice(body);
    out
}

/// Read one frame's body. A stream that ends before a header is
/// [`FrameError::Closed`]; one that ends inside a frame is an error.
pub fn read<R: Read>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
    let mut h = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut h[got..]) {
            Ok(0) if got == 0 => return Err(FrameError::Closed),
            Ok(0) => return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into())),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    let n = length(h, max)?;
    let mut body = vec![0u8; n];
    r.read_exact(&mut body)?;
    Ok(body)
}

/// Write one frame, refusing a body over `max`.
pub fn write<W: Write>(w: &mut W, body: &[u8], max: usize) -> io::Result<()> {
    if body.is_empty() || body.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a {}-byte frame is over the limit", body.len()),
        ));
    }
    w.write_all(&encode(body))?;
    w.flush()
}

/// The async halves, for the app's side of the socket.
pub mod tokio_io {
    use super::{length, FrameError};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    pub async fn read<R: AsyncRead + Unpin>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
        let mut h = [0u8; 4];
        match r.read_exact(&mut h).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Err(FrameError::Closed)
            }
            Err(e) => return Err(e.into()),
        }
        let n = length(h, max)?;
        let mut body = vec![0u8; n];
        r.read_exact(&mut body).await?;
        Ok(body)
    }

    pub async fn write<W: AsyncWrite + Unpin>(
        w: &mut W,
        body: &[u8],
        max: usize,
    ) -> std::io::Result<()> {
        if body.is_empty() || body.len() > max {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("a {}-byte frame is over the limit", body.len()),
            ));
        }
        w.write_all(&super::encode(body)).await?;
        w.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_in_chromes_byte_order() {
        let body = br#"{"t":"hello"}"#;
        let framed = encode(body);
        assert_eq!(&framed[..4], &(body.len() as u32).to_ne_bytes());
        let mut c = Cursor::new(framed);
        assert_eq!(read(&mut c, 100).unwrap(), body);
        assert!(matches!(read(&mut c, 100), Err(FrameError::Closed)));
    }

    #[test]
    fn two_frames_back_to_back() {
        let mut buf = encode(b"one");
        buf.extend(encode(b"two"));
        let mut c = Cursor::new(buf);
        assert_eq!(read(&mut c, 10).unwrap(), b"one");
        assert_eq!(read(&mut c, 10).unwrap(), b"two");
    }

    #[test]
    fn over_the_limit_or_empty_is_refused() {
        let mut c = Cursor::new(encode(b"0123456789"));
        assert!(matches!(read(&mut c, 9), Err(FrameError::TooLong(10))));
        let mut c = Cursor::new(0u32.to_ne_bytes().to_vec());
        assert!(matches!(read(&mut c, 9), Err(FrameError::TooLong(0))));
        let mut out = Vec::new();
        assert!(write(&mut out, &[b'x'; 11], 10).is_err());
        assert!(write(&mut out, b"", 10).is_err());
        assert!(out.is_empty());
    }

    #[test]
    fn a_stream_cut_mid_frame_is_an_error_not_a_close() {
        let mut framed = encode(b"abcdef");
        framed.truncate(6);
        let mut c = Cursor::new(framed);
        assert!(matches!(read(&mut c, 100), Err(FrameError::Io(_))));
        let mut c = Cursor::new(vec![1u8, 0]);
        assert!(matches!(read(&mut c, 100), Err(FrameError::Io(_))));
    }

    #[test]
    fn chromes_limits() {
        assert_eq!(MAX_TO_CHROME, 1 << 20);
        assert_eq!(MAX_FROM_CHROME, 64 << 20);
    }

    #[tokio::test]
    async fn async_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(64);
        tokio_io::write(&mut a, b"ping", 10).await.unwrap();
        drop(a);
        assert_eq!(tokio_io::read(&mut b, 10).await.unwrap(), b"ping");
        assert!(matches!(
            tokio_io::read(&mut b, 10).await,
            Err(FrameError::Closed)
        ));
    }
}
