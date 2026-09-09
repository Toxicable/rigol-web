# DHO804 scope control expansion

Date: 2026-09-09

RigolWeb now exposes the DHO804 configuration state that was previously read and displayed but not writable from the scope route.

## Added browser controls

- Per-channel coupling: AC, DC, GND.
- Per-channel probe attenuation selector: 1× or 10×.
- Horizontal mode: Main, Roll, XY.
- Trigger sweep: Auto, Normal, Single.
- Edge-trigger coupling: AC, DC, LF reject, HF reject.
- Acquisition type: Normal, Peak, Average, Ultra.
- Acquisition average count: powers of two from 2 through 65536.
- Acquisition memory depth: DHO804-supported numeric depths, constrained by enabled-channel count.

Sample rate remains authoritative/read-only. Advanced trigger types remain readable and can still be switched back to Edge, but type-specific controls for Pulse/Slope/serial/etc. are not added by this change.

## DHO804 command mapping

The implementation follows the RIGOL DHO800/DHO900 Programming Guide:

- `:CHANnel<n>:COUPling AC|DC|GND`
- `:CHANnel<n>:PROBe 1|10`
- `:TIMebase:MODE MAIN|ROLL|XY`
- `:TRIGger:SWEep AUTO|NORMal|SINGle`
- `:TRIGger:COUPling AC|DC|LFReject|HFReject`
- `:ACQuire:TYPE NORMal|PEAK|AVERages|ULTRa`
- `:ACQuire:AVERages <count>`
- `:ACQuire:MDEPth <depth>`

Programming guide: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

The DHO804 memory-depth limits used by the UI/server are 25 Mpts with one enabled channel, 10 Mpts with two, and 5 Mpts with three or four. The DHO900-only higher-depth combinations are deliberately not offered.

## State and protocol behavior

These controls are typed `ControlChange` variants rather than browser-issued raw SCPI. Protocol version is hard-cut from 7 to 8; existing message values, including the version-7 acquisition-operation messages 60-65, remain stable.

The server validates values, writes the corresponding DHO804 SCPI command through the normal serialized driver path, then reads back the affected authoritative state where the setting can alter related physical state. Raw driver execution invalidates cached waveform setup before subsequent live reads.

Probe writes intentionally accept only 1× or 10×. If the physical scope is already on another supported attenuation, RigolWeb displays that current value until the user selects 1× or 10×.

No hardware, software package or service purchase is introduced by this change. Incremental cost: **A$0**.
