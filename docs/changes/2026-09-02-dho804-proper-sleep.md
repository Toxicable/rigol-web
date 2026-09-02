# DHO804 proper sleep research

## Current RigolWeb behaviour

`Dho804DisplayControl` currently sends Android `KEYCODE_SLEEP` (`223`) for **Screen Off** and `KEYCODE_WAKEUP` (`224`) for **Screen On** over ADB. These are display-level Android actions, not the DHO804 instrument's `Power > Sleep` mode.

Keep Screen Off/On with those semantics.

## Stock Rigol Sleep behaviour

The decompiled DHO800 scope application shows the implementation of its `button_sleep` handler. It:

1. unloads `/rigol/driver/focaltech_ts.ko`;
2. turns off all front-panel LEDs through Rigol's native CIL `MSG_APP_UTILITY_LED` calls;
3. broadcasts `com.rigol.watchdog.QuickOpenStatus` with `quickOpenStatus=0`;
4. executes `su -c "/rigol/shell/quick_boot_test.sh off"`.

Therefore RigolWeb should not treat Android `KEYCODE_SLEEP` as instrument Sleep, and should not clone this internal sequence in the server. The native CIL portion in particular belongs to the installed Rigol application/firmware.

## Preferred RigolWeb Sleep action

Invoke the stock Rigol UI path remotely:

1. send the Rigol panel-power key over ADB;
2. locate the stock `com.rigol.scope:id/button_sleep` node with `uiautomator dump`;
3. tap the centre of that node's bounds.

The Rigol app maps panel keys by subtracting `0x40000000` from the Android key code. Its power handler is panel key `27`, giving:

`0x40000000 + 27 = 0x4000001B = 1073741851`

Candidate command to open the power popup:

`adb -s <scope-ip>:<adb-port> shell input keyevent 1073741851`

Do not use fixed tap coordinates if resource lookup works. Do not use standard Android `KEYCODE_POWER` (`26`) as the primary candidate; it is not the key namespace used by Rigol's panel-key decoder.

## Verification gate

Before shipping a **Sleep** control as the default action on the real DHO804, verify on the installed firmware that:

- keycode `1073741851` opens the Rigol power popup;
- `uiautomator dump` exposes `com.rigol.scope:id/button_sleep`;
- tapping that node enters the same state as local `Power > Sleep`.

This is expected to be low-risk because the final action is the stock Rigol button handler, but the injected panel-key/resource-discovery path is firmware-dependent and has not yet been bench-confirmed.

## Wake is separate

Do not relabel the existing **Screen On** action as proper Sleep wake.

Rigol documents the physical front-panel power key as the wake action. Public reverse-engineered sources do not establish whether ADB/LAN remains alive during proper Sleep. After entering proper Sleep, test TCP/ADB reachability and, if still reachable, test keycode `1073741851` for resume.

If ADB becomes unreachable, proper Sleep cannot be remotely woken through the existing LAN ADB mechanism. Reliable remote cold-start remains external power switching with `:SYSTem:PSTatus OPEN`, which is a full boot rather than resume.

## Sources

- Rigol DHO800 User Guide: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- Decompiled Rigol `PowerPopupView`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/views/power/PowerPopupView.java
- Decompiled Rigol `PanelKeyViewModel`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/viewmodels/PanelKeyViewModel.java
- Decompiled Rigol `KeyCodeUtil`: https://github.com/Andy-Big/Rigol-DHO800-900-Sparrow_mod/blob/master_00.01.04.00.02/java_src/com/rigol/scope/utilities/KeyCodeUtil.java
- Sparrow power popup layout: https://github.com/mriscoc/Sparrow-Extended-UI-for-RIGOL-DHO800_DHO900/blob/master/SparrowApp/res/layout/popupview_power.xml
