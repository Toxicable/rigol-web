# DHO804 proper sleep and wake control

## Current behavior

Rigol Web exposes one adaptive instrument **Sleep/Wake** control. The old
display-only **Screen Off** / **Screen On** controls and their HTTP endpoints
have been removed.

The backend endpoints are now only:

- `POST /api/scope/sleep`
- `POST /api/scope/wake`

While normally connected the toolbar button reads **Sleep**. After a successful
Sleep request it immediately changes to **Wake**. Whenever the scope is
disconnected the button is also forced to **Wake**. After wake and scope
reconnection it returns to **Sleep**.

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

`Dho804PowerControl.sleep()`:

1. connects to the configured DHO804 ADB endpoint;
2. injects Rigol panel-power key `1073741851`;
3. waits 500 ms for the stock power popup;
4. taps the centre of the stock Sleep button at `(324, 375)`.

The coordinate is derived from the DHO800 application resources and confirmed
against a real DHO804 1024x600 framebuffer capture. The stock popup is
`560x270 dp`, centered, and the `110x35 dp` Sleep button is centered in its
left-third column. Those constraints place the button centre at approximately
`x=324.4`, `y=374.5`.

## Implemented Wake sequence

`Dho804PowerControl.wake()` attempts both wake candidates independently:

1. Rigol panel-power key `1073741851`;
2. Android `KEYCODE_WAKEUP` (`224`).

Each attempt is logged as command success or failure. After both attempts,
Rigol Web reconnects if possible and runs `dumpsys power`; if
`mWakefulness=<state>` is present, that state is logged.

The HTTP wake request fails only when both key-injection attempts fail. A failed
power-state probe is diagnostic only.

## Verification state

Verified so far:

- panel-power key `1073741851` opens the native Rigol power popup;
- `uiautomator` resource discovery is unsuitable for this scope and is removed;
- the real framebuffer geometry matches the stock layout used for the Sleep tap.

Still to verify:

- the `(324, 375)` tap executes the stock Sleep button;
- whether ADB remains reachable during proper Sleep;
- which Wake candidate resumes the scope.

Useful server log lines are:

- `[DHO804 sleep] clicked native Rigol Sleep control at 324,375`
- `[DHO804 wake] Rigol panel power key: ...`
- `[DHO804 wake] Android KEYCODE_WAKEUP: ...`
- `[DHO804 wake] power-state probe after attempts: ...`

If ADB becomes unreachable during proper Sleep, neither LAN ADB wake candidate
can work from that state. Reliable remote cold-start then remains external power
switching with `:SYSTem:PSTatus OPEN`, which is a full boot rather than resume.

## Cost

No additional hardware or paid service is required. Cost impact: **A$0**.

## Sources

- Rigol DHO800 User Guide: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- Decompiled Rigol `PowerPopupView`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/views/power/PowerPopupView.java
- Decompiled Rigol `PanelKeyViewModel`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/viewmodels/PanelKeyViewModel.java
- Decompiled Rigol `KeyCodeUtil`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/utilities/KeyCodeUtil.java
- Sparrow power popup layout: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/layout/popupview_power.xml
- Sparrow popup/button styles: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/values/styles.xml
