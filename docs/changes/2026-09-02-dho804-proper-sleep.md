# DHO804 proper sleep control

## Current behavior

Rigol Web exposes a one-way instrument **Sleep** control. Remote Wake has been
removed because real-scope testing on 2026-09-02 confirmed that native Sleep
takes the DHO804 off the network. Once asleep, neither the SCPI endpoint nor LAN
ADB is reachable, so a LAN-only wake request cannot work.

The backend power endpoint is now only:

- `POST /api/scope/sleep`

`POST /api/scope/wake` no longer exists.

## Why native Sleep uses the Rigol UI path

The decompiled DHO800 scope application shows that its `button_sleep` handler:

1. unloads `/rigol/driver/focaltech_ts.ko`;
2. turns off all front-panel LEDs through Rigol's native CIL
   `MSG_APP_UTILITY_LED` calls;
3. broadcasts `com.rigol.watchdog.QuickOpenStatus` with `quickOpenStatus=0`;
4. executes `su -c "/rigol/shell/quick_boot_test.sh off"`.

Rigol Web therefore invokes the installed Rigol application's own Sleep button
instead of reproducing that private sequence.

## Verified panel-power injection

Real-scope testing on 2026-09-02 confirmed that Rigol panel-power key
`1073741851` opens the DHO804's stock power popup.

The Rigol app maps panel keys by subtracting `0x40000000` from the Android key
code. Its power handler is panel key `27`, giving:

`0x40000000 + 27 = 0x4000001B = 1073741851`

The first implementation tried to discover
`com.rigol.scope:id/button_sleep` with `uiautomator dump`. On the real scope
that stage did not click the Sleep control, despite the popup opening correctly,
so that path has been removed.

## Implemented Sleep sequence

The HTTP Sleep action coordinates the SCPI runtime and
`Dho804PowerControl.sleep()` as one lifecycle:

1. suspend the DHO804 instrument runtime while preserving browser subscribers;
2. wait for the current SCPI session, live waveform stream, scheduler, and
   transport to stop cleanly;
3. connect to the configured DHO804 ADB endpoint;
4. inject Rigol panel-power key `1073741851`;
5. wait 1500 ms for the stock power popup to finish rendering;
6. re-check ADB immediately before the final action;
7. launch the ADB tap for the stock Sleep button at `(324, 375)`;
8. return once that final local ADB client process has successfully started,
   rather than waiting for its exit status.

The final tap is intentionally treated as a one-way action. Real-scope testing
showed the instrument could enter Sleep successfully while the HTTP request
still returned 502. A successful Sleep transition can tear down the connection
used by the final ADB client before that client reports a normal exit status, so
waiting for process completion produces a false failure. Preflight ADB checks
still fail the request before dispatch if the target is not reachable, and a
local failure to launch the final ADB process is still reported as an error.

The coordinate is derived from the DHO800 application resources and confirmed
against a real DHO804 1024x600 framebuffer capture. The stock popup is
`560x270 dp`, centered, and the `110x35 dp` Sleep button is centered in its
left-third column. Those constraints place the button centre at approximately
`x=324.4`, `y=374.5`.

If the native Sleep action fails before it has been dispatched, Rigol Web
resumes the DHO804 SCPI runtime so an existing browser session is not left
artificially suspended.

## Physical wake and automatic SCPI recovery

The DHO804 must be woken physically using its front-panel power key. Rigol Web
does not present a Wake button or attempt ADB wake commands while the instrument
is offline.

After a successful Sleep dispatch, the server keeps the SCPI runtime suspended
and performs only a quiet TCP reachability probe against the configured SCPI
port every 2 seconds. It sends no SCPI commands. The monitor requires an actual
offline transition before it will treat later reachability as a physical wake.
When the SCPI TCP endpoint becomes reachable again, Rigol Web resumes the
instrument runtime and existing browser subscribers reconnect automatically.

This avoids the previous stream/query errors and repeated SCPI reconnect errors
while the sleeping scope is absent from the network.

## Verification state

Verified on the real scope:

- panel-power key `1073741851` opens the native Rigol power popup;
- `uiautomator` resource discovery is unsuitable for this scope and is removed;
- the real framebuffer geometry matches the stock layout used for the Sleep tap;
- the `(324, 375)` tap executes the stock Sleep action;
- successful Sleep can coincide with loss of the final command connection, so
  command-process completion is not a valid Sleep acknowledgement;
- native Sleep takes the DHO804 offline on the network, making LAN ADB wake
  unavailable.

Still to verify on the real instrument:

- that physical front-panel wake restores the SCPI endpoint cleanly enough for
  the new reachability monitor to resume the runtime without manual intervention.

Useful server log lines are:

- `[DHO804 sleep] dispatched native Rigol Sleep control at 324,375`
- `[DHO804 sleep] SCPI endpoint reachable after physical wake; resuming runtime`

## Reliable remote cold-start option

For genuinely remote restart, external power switching remains the reliable
option. Set:

`:SYSTem:PSTatus OPEN`

Then the DHO804 starts automatically when its DC input is restored. This is a
full boot rather than Sleep resume. Avoid routinely removing power from the
running Android-based scope without a clean shutdown.

## Cost

No additional hardware or paid service is required for the Sleep implementation
or physical-wake detection. Cost impact: **A$0**. Remote cold-start would require
whatever external power switch/relay hardware is chosen.

## Sources

- Rigol DHO800 User Guide: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- Decompiled Rigol `PowerPopupView`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/views/power/PowerPopupView.java
- Decompiled Rigol `PanelKeyViewModel`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/viewmodels/PanelKeyViewModel.java
- Decompiled Rigol `KeyCodeUtil`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/utilities/KeyCodeUtil.java
- Sparrow power popup layout: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/layout/popupview_power.xml
- Sparrow popup/button styles: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/values/styles.xml
