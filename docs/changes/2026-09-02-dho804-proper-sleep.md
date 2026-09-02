# DHO804 proper sleep and wake control

## Behavior split

Rigol Web keeps display power separate from instrument sleep:

- **Screen Off**: Android `KEYCODE_SLEEP` (`223`), display-only.
- **Screen On**: Android `KEYCODE_WAKEUP` (`224`), display-only.
- **Sleep/Wake**: one adaptive instrument-power button. It invokes proper Rigol Sleep while the scope is awake and changes to Wake after a successful Sleep request or whenever the SCPI/WebSocket scope connection is down.

Do not collapse Screen Off/On into instrument Sleep/Wake; they have different instrument semantics.

## Why native Sleep must use the Rigol UI path

The decompiled DHO800 scope application shows that its `button_sleep` handler:

1. unloads `/rigol/driver/focaltech_ts.ko`;
2. turns off all front-panel LEDs through Rigol's native CIL `MSG_APP_UTILITY_LED` calls;
3. broadcasts `com.rigol.watchdog.QuickOpenStatus` with `quickOpenStatus=0`;
4. executes `su -c "/rigol/shell/quick_boot_test.sh off"`.

Rigol Web therefore does not reproduce that private sequence. It invokes the installed Rigol application's own Sleep button so the firmware remains responsible for the complete transition.

## Verified panel-power injection

Real-scope testing on 2026-09-02 confirmed that injecting Rigol panel-power key `1073741851` opens the DHO804's stock power popup.

The Rigol app maps panel keys by subtracting `0x40000000` from the Android key code. Its power handler is panel key `27`, giving:

`0x40000000 + 27 = 0x4000001B = 1073741851`

The first implementation then tried to discover `com.rigol.scope:id/button_sleep` with `uiautomator dump`. On the real scope that stage did not click the Sleep control, despite the popup opening correctly. The failed request also exposed a separate frontend problem where an upstream HTML 502 body was displayed verbatim in the instrument header.

## Implemented Sleep sequence

`Dho804DisplayControl.sleep()` now:

1. connects to the configured DHO804 ADB endpoint;
2. injects Rigol panel-power key `1073741851`;
3. waits 500 ms for the stock power popup;
4. taps the centre of the stock Sleep button at `(324, 375)`.

The coordinate is derived from the actual DHO800 application resources and confirmed against a real DHO804 1024x600 framebuffer capture:

- instrument UI: `1024x600`;
- `App.PopupWindow.Common.Alert`: `560x270 dp`, centered;
- power-popup Sleep button: `110x35 dp`, centered in the left 33% column with the stock bottom/divider constraints.

Those constraints place the button centre at approximately `x=324.4`, `y=374.5`, rounded to `(324, 375)`. The action still clicks Rigol's own button, so the installed firmware executes the complete native Sleep handler.

`uiautomator` is no longer in the Sleep request path.

## Implemented Wake sequence

`Dho804DisplayControl.wake()` attempts both wake candidates independently, even if the first one fails:

1. Rigol panel-power key `1073741851`;
2. Android `KEYCODE_WAKEUP` (`224`).

Each attempt is logged as either command success or failure. After both attempts, Rigol Web reconnects if possible and runs `dumpsys power`; if `mWakefulness=<state>` is present, that state is logged.

The HTTP wake request fails only when both key-injection attempts fail. A failed `dumpsys power` probe is diagnostic only and is logged without changing an otherwise successful wake result.

## HTTP and UI

The backend retains explicit endpoints:

- `POST /api/scope/screen-off`
- `POST /api/scope/screen-on`
- `POST /api/scope/sleep`
- `POST /api/scope/wake`

The toolbar exposes **Screen Off**, **Screen On**, and one adaptive **Sleep/Wake** button. While normally connected the button reads **Sleep**. After a successful Sleep request it immediately changes to **Wake**, even before any connection-state update. Whenever the scope is disconnected the button is also forced to **Wake**. After a successful wake and scope reconnection it returns to **Sleep**.

Power-control API errors are sanitized before being shown in the header. Only short `text/plain` backend error bodies are displayed; HTML/proxy error pages and oversized responses collapse to a concise HTTP-status error instead of being inserted into the toolbar.

## Verification state

Verified on the real DHO804 so far:

- panel-power key `1073741851` opens the native Rigol power popup;
- the `uiautomator` resource-discovery path is not suitable for the real scope and has been removed;
- the real framebuffer geometry matches the stock 1024x600 popup layout used to calculate the Sleep tap.

Still to verify:

- the `(324, 375)` tap executes the stock Sleep button;
- whether ADB remains reachable during proper Sleep;
- which Wake candidate, if either, resumes the scope.

Useful server log lines around one Sleep/Wake cycle are:

- `[DHO804 sleep] clicked native Rigol Sleep control at 324,375`
- `[DHO804 wake] Rigol panel power key: ...`
- `[DHO804 wake] Android KEYCODE_WAKEUP: ...`
- `[DHO804 wake] power-state probe after attempts: ...` or the corresponding probe failure.

If ADB becomes unreachable during proper Sleep, neither LAN ADB wake candidate can work from that state. Reliable remote cold-start then remains external power switching with `:SYSTem:PSTatus OPEN`, which is a full boot rather than resume.

## Cost

No additional hardware or paid service is required. Cost impact: **A$0**.

## Sources

- Rigol DHO800 User Guide: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- Decompiled Rigol `PowerPopupView`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/views/power/PowerPopupView.java
- Decompiled Rigol `PanelKeyViewModel`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/viewmodels/PanelKeyViewModel.java
- Decompiled Rigol `KeyCodeUtil`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/utilities/KeyCodeUtil.java
- Sparrow power popup layout: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/layout/popupview_power.xml
- Sparrow popup/button styles: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/values/styles.xml
