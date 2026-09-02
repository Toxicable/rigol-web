# DHO804 proper sleep and wake control

## Behavior split

Rigol Web keeps four separate DHO804 power/display actions:

- **Screen Off**: Android `KEYCODE_SLEEP` (`223`), display-only.
- **Screen On**: Android `KEYCODE_WAKEUP` (`224`), display-only.
- **Sleep**: invoke the stock Rigol `Power > Sleep` button remotely.
- **Wake**: attempt both candidate wake key paths and log the result of each.

Do not collapse Screen Off/On into Sleep/Wake; they have different instrument semantics.

## Why native Sleep must use the Rigol UI path

The decompiled DHO800 scope application shows that its `button_sleep` handler:

1. unloads `/rigol/driver/focaltech_ts.ko`;
2. turns off all front-panel LEDs through Rigol's native CIL `MSG_APP_UTILITY_LED` calls;
3. broadcasts `com.rigol.watchdog.QuickOpenStatus` with `quickOpenStatus=0`;
4. executes `su -c "/rigol/shell/quick_boot_test.sh off"`.

Rigol Web therefore does not reproduce that private sequence. It invokes the installed Rigol application's own Sleep button so the firmware remains responsible for the complete transition.

## Implemented Sleep sequence

`Dho804DisplayControl.sleep()` now:

1. connects to the configured DHO804 ADB endpoint;
2. injects Rigol's panel-power key `1073741851`;
3. waits 300 ms for the stock power popup;
4. runs `uiautomator dump /sdcard/rigol-web-window.xml`;
5. reads that hierarchy and finds `com.rigol.scope:id/button_sleep`;
6. parses the control bounds and taps their centre.

It deliberately fails instead of using a fixed coordinate if the native Sleep resource cannot be found.

The Rigol app maps panel keys by subtracting `0x40000000` from the Android key code. Its power handler is panel key `27`, giving:

`0x40000000 + 27 = 0x4000001B = 1073741851`

## Implemented Wake sequence

`Dho804DisplayControl.wake()` attempts both wake candidates independently, even if the first one fails:

1. Rigol panel-power key `1073741851`;
2. Android `KEYCODE_WAKEUP` (`224`).

Each attempt is logged as either command success or failure. After both attempts, Rigol Web reconnects if possible and runs `dumpsys power`; if `mWakefulness=<state>` is present, that state is logged.

The HTTP wake request fails only when both key-injection attempts fail. A failed `dumpsys power` probe is diagnostic only and is logged without changing an otherwise successful wake result.

This is intentional because the first real-scope test is meant to establish which wake mechanism, if either, survives the DHO804's proper Sleep state.

## HTTP and UI

The backend exposes:

- `POST /api/scope/screen-off`
- `POST /api/scope/screen-on`
- `POST /api/scope/sleep`
- `POST /api/scope/wake`

The DHO804 toolbar exposes matching **Screen Off**, **Screen On**, **Sleep**, and **Wake** buttons.

## Verification state

Implementation is complete, but the proper Sleep/Wake path still needs a real-scope bench check because ADB availability during Rigol Sleep is firmware behavior that cannot be established from the decompiled application alone.

The next real-scope run should capture these server log lines around one Sleep/Wake cycle:

- `[DHO804 sleep] clicked native Rigol Sleep control at ...`
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
