use std::fmt;

/// Errors returned by [`crate::Hnsw`] operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A vector had a different dimensionality than the index expects.
    DimensionMismatch {
        /// Dimensionality the index was created with.
        expected: usize,
        /// Dimensionality of the offending vector.
        got: usize,
    },
    /// The serialized byte blob did not start with the expected magic header.
    BadFormat,
    /// The serialized format version is not supported by this build.
    VersionMismatch(u32),
    /// Serialization failed (wraps the underlying error message).
    Serialize(String),
    /// Deserialization failed (wraps the underlying error message).
    Deserialize(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::DimensionMismatch { expected, got } => {
                write!(f, "dimension mismatch: expected {expected}, got {got}")
            }
            Error::BadFormat => write!(f, "bad format: missing or invalid magic header"),
            Error::VersionMismatch(v) => write!(f, "unsupported format version: {v}"),
            Error::Serialize(msg) => write!(f, "serialize error: {msg}"),
            Error::Deserialize(msg) => write!(f, "deserialize error: {msg}"),
        }
    }
}

impl std::error::Error for Error {}
