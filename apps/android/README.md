# AEEIS for Android

The inbox and the decisions on it, with push for what needs you. Interaction design §11.6 puts these first on a
phone; groups, the task board and the studio open in the browser.

- **Inbox**: Runs waiting for your approval or answer, and blocked tasks in groups you own (the same S1 rule as the
  web inbox and the push pump). It refreshes every 15 seconds while it is on screen.
- **A Run**: its plan and steps; approve, approve just this once, send it back with what to change, or answer its
  question. "在网页版看完整过程" opens the Run on the web.
- **Push**: Firebase Cloud Messaging. Off by default; turned on per phone in 设置. Tapping a push opens that Run
  here, or a group in the browser.

## Build

Needs JDK 17 and the Android SDK (platform 35).

```bash
cd apps/android
./gradlew testDebugUnitTest assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. To try it against a local AEEIS in the emulator, connect to
`http://10.0.2.2:<port>`; plain HTTP is allowed only for the emulator's host and this device, everything else must be
HTTPS.

`LiveServerTest` runs the app's client against a running AEEIS (for example `npm run demo:local`): it creates Runs,
finds them in the inbox, approves one, sends one back with feedback, and checks a stale plan is refused. It is skipped
unless `AEEIS_E2E_SERVER` is set:

```bash
AEEIS_E2E_SERVER=http://127.0.0.1:4391 ./gradlew testDebugUnitTest
```

## Push

A build without Firebase settings has no push, and says so in 设置. To turn it on:

1. Create a Firebase project and add an Android app with the package `co.x2v.aeeis`.
2. Put its settings in `~/.gradle/gradle.properties` (not in the repository):

   ```properties
   aeeisFcmApplicationId=1:1234567890:android:abcdef
   aeeisFcmProjectId=your-project
   aeeisFcmApiKey=AIza...
   aeeisFcmSenderId=1234567890
   ```

3. On the server, set `AEEIS_FCM_SERVICE_ACCOUNT_FILE` to a service account JSON from the same project.
