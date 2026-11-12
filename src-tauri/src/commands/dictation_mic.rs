//! Which microphone dictation listens on.
//!
//! The Mac's default input is often a Bluetooth headset (AirPods, Marshall,
//! Sony…). Opening a Bluetooth microphone makes macOS switch the headset from
//! its music profile to its call profile: whatever is playing turns tinny for
//! as long as the mic is open, and the switch itself reconfigures the audio
//! engine a moment after it starts, which stops capture, so nothing is heard.
//! When the default input is Bluetooth and the Mac has a built-in microphone,
//! dictation uses the built-in one instead: the headphones stay in music mode
//! and the engine never sees a route change. Any other default (a USB or
//! studio mic, the built-in one) is left alone: the user chose it.

/// Where an input device is connected, in the words the logs use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    BuiltIn,
    Bluetooth,
    Other,
}

/// What dictation will listen on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicChoice {
    /// The CoreAudio device to set on the engine's input, or None to leave
    /// the engine on the system default.
    pub device: Option<u32>,
    pub name: String,
    pub transport: Transport,
    /// The default was a Bluetooth mic and the built-in one is used instead.
    pub avoided_bluetooth: bool,
}

/// One input device as CoreAudio describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    pub id: u32,
    pub name: String,
    pub transport: Transport,
}

/// The rule, separated from CoreAudio so it can be tested.
pub fn choose(default: Option<&InputDevice>, inputs: &[InputDevice]) -> Option<MicChoice> {
    let default = default?;
    if default.transport == Transport::Bluetooth {
        if let Some(built_in) = inputs.iter().find(|d| d.transport == Transport::BuiltIn) {
            return Some(MicChoice {
                device: Some(built_in.id),
                name: built_in.name.clone(),
                transport: Transport::BuiltIn,
                avoided_bluetooth: true,
            });
        }
    }
    Some(MicChoice {
        device: None,
        name: default.name.clone(),
        transport: default.transport,
        avoided_bluetooth: false,
    })
}

#[cfg(target_os = "macos")]
pub mod core_audio {
    use super::*;
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn AudioUnitSetProperty(
            unit: *mut c_void,
            id: u32,
            scope: u32,
            element: u32,
            data: *const c_void,
            size: u32,
        ) -> i32;
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
    }

    const SYSTEM_OBJECT: u32 = 1;
    const SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const SCOPE_INPUT: u32 = fourcc(b"inpt");
    const ELEMENT_MAIN: u32 = 0;
    const DEFAULT_INPUT: u32 = fourcc(b"dIn ");
    const DEVICES: u32 = fourcc(b"dev#");
    const STREAMS: u32 = fourcc(b"stm#");
    const TRANSPORT: u32 = fourcc(b"tran");
    const NAME: u32 = fourcc(b"lnam");
    const BUILT_IN: u32 = fourcc(b"bltn");
    const BLUETOOTH: u32 = fourcc(b"blue");
    const BLUETOOTH_LE: u32 = fourcc(b"blea");
    /// `kAudioOutputUnitProperty_CurrentDevice`.
    const CURRENT_DEVICE: u32 = 2000;

    fn addr(selector: u32, scope: u32) -> PropertyAddress {
        PropertyAddress {
            selector,
            scope,
            element: ELEMENT_MAIN,
        }
    }

    fn get_u32(object: u32, selector: u32, scope: u32) -> Option<u32> {
        let a = addr(selector, scope);
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut c_void,
            )
        };
        (status == 0).then_some(value)
    }

    fn data_size(object: u32, selector: u32, scope: u32) -> Option<u32> {
        let a = addr(selector, scope);
        let mut size: u32 = 0;
        let status =
            unsafe { AudioObjectGetPropertyDataSize(object, &a, 0, std::ptr::null(), &mut size) };
        (status == 0).then_some(size)
    }

    fn name(id: u32) -> String {
        let a = addr(NAME, SCOPE_GLOBAL);
        let mut cf: CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                &mut cf as *mut CFStringRef as *mut c_void,
            )
        };
        if status != 0 || cf.is_null() {
            return "a microphone".into();
        }
        // The property returns a +1 reference.
        unsafe { CFString::wrap_under_create_rule(cf) }.to_string()
    }

    fn transport(id: u32) -> Transport {
        match get_u32(id, TRANSPORT, SCOPE_GLOBAL) {
            Some(BUILT_IN) => Transport::BuiltIn,
            Some(BLUETOOTH) | Some(BLUETOOTH_LE) => Transport::Bluetooth,
            _ => Transport::Other,
        }
    }

    fn describe(id: u32) -> InputDevice {
        InputDevice {
            id,
            name: name(id),
            transport: transport(id),
        }
    }

    fn inputs() -> Vec<InputDevice> {
        let Some(size) = data_size(SYSTEM_OBJECT, DEVICES, SCOPE_GLOBAL) else {
            return Vec::new();
        };
        let count = size as usize / std::mem::size_of::<u32>();
        let mut ids = vec![0u32; count];
        let a = addr(DEVICES, SCOPE_GLOBAL);
        let mut size = size;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &a,
                0,
                std::ptr::null(),
                &mut size,
                ids.as_mut_ptr() as *mut c_void,
            )
        };
        if status != 0 {
            return Vec::new();
        }
        ids.into_iter()
            .filter(|&id| data_size(id, STREAMS, SCOPE_INPUT).is_some_and(|s| s > 0))
            .map(describe)
            .collect()
    }

    /// The microphone dictation should use right now.
    pub fn pick() -> Option<MicChoice> {
        let default = get_u32(SYSTEM_OBJECT, DEFAULT_INPUT, SCOPE_GLOBAL)
            .filter(|&id| id != 0)
            .map(describe);
        choose(default.as_ref(), &inputs())
    }

    /// Point an `AVAudioInputNode`'s audio unit at `device`. Must happen
    /// before the node's format is read and before the engine starts.
    ///
    /// # Safety
    /// `unit` must be the input node's live `AudioUnit`.
    pub unsafe fn set_device(unit: *mut c_void, device: u32) -> bool {
        if unit.is_null() {
            return false;
        }
        AudioUnitSetProperty(
            unit,
            CURRENT_DEVICE,
            SCOPE_GLOBAL,
            0,
            &device as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        ) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: u32, name: &str, transport: Transport) -> InputDevice {
        InputDevice {
            id,
            name: name.into(),
            transport,
        }
    }

    #[test]
    fn a_bluetooth_default_gives_way_to_the_built_in_mic() {
        let headset = dev(70, "MAJOR V", Transport::Bluetooth);
        let mac = dev(80, "MacBook Pro Microphone", Transport::BuiltIn);
        let choice = choose(Some(&headset), &[headset.clone(), mac]).unwrap();
        assert_eq!(choice.device, Some(80));
        assert_eq!(choice.transport, Transport::BuiltIn);
        assert!(choice.avoided_bluetooth);
    }

    #[test]
    fn bluetooth_stays_when_there_is_no_built_in_mic() {
        let headset = dev(70, "AirPods", Transport::Bluetooth);
        let choice = choose(Some(&headset), std::slice::from_ref(&headset)).unwrap();
        assert_eq!(choice.device, None);
        assert!(!choice.avoided_bluetooth);
    }

    #[test]
    fn a_chosen_usb_or_built_in_mic_is_left_alone() {
        let usb = dev(5, "Shure MV7", Transport::Other);
        let mac = dev(80, "MacBook Pro Microphone", Transport::BuiltIn);
        let choice = choose(Some(&usb), &[usb.clone(), mac.clone()]).unwrap();
        assert_eq!(choice.device, None);
        assert_eq!(choice.name, "Shure MV7");
        let choice = choose(Some(&mac), std::slice::from_ref(&mac)).unwrap();
        assert_eq!(choice.device, None);
    }

    #[test]
    fn no_default_input_means_no_choice() {
        assert_eq!(choose(None, &[]), None);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod live {
    /// Prints what this Mac would use. `cargo test --lib dictation_mic::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn print_this_macs_choice() {
        println!("{:?}", super::core_audio::pick());
    }
}
