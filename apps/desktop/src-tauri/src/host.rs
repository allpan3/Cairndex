// Reports the compile-time host without introducing native OS APIs
pub(crate) const fn current() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "macos";
    }
    #[cfg(target_os = "windows")]
    {
        return "windows";
    }
    #[cfg(target_os = "linux")]
    {
        return "linux";
    }
    #[allow(unreachable_code)]
    "other"
}

#[cfg(test)]
mod tests {
    use super::*;

    // Confirms the supported build hosts never fall through to Other
    #[test]
    fn current_host_is_known() {
        assert_ne!(current(), "other");
    }
}
