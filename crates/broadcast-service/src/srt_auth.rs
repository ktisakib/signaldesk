use sha2::{Digest, Sha256};

// SRT stream IDs are handshake metadata: never put the encryption passphrase there.
pub fn proof(key: &str) -> String {
    format!(
        "{:x}",
        Sha256::new()
            .chain_update(b"signaldesk-srt-auth-v1:")
            .chain_update(key.as_bytes())
            .finalize()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_is_domain_separated_and_changes_with_the_key() {
        assert_eq!(
            proof("abc"),
            "47df6215c5a17dcb7bb4a771244bea3e62891ef2d20e73f52cd65a2196688506"
        );
        assert_ne!(proof("abc"), proof("abd"));
    }
}
