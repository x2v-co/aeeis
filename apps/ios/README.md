# AEEIS for iPhone

The inbox and the decisions on it, with APNs push for what needs you. Interaction design §11.6 puts these first on a
phone; groups, the task board and the studio open in Safari.

- **Inbox**: Runs waiting for your approval or answer, and blocked tasks in groups you own (the same S1 rule as the
  web inbox and the push pump). Pull to refresh; it also refreshes every 15 seconds while on screen.
- **A Run**: its plan and steps; approve, approve just this once, send it back with what to change, or answer its
  question. "在网页版看完整过程" opens the Run on the web.
- **Push**: APNs, off by default, turned on per phone in 设置. Tapping a push opens that Run, or a group in Safari.
- The access token is kept in the Keychain.

## Layout

- `Sources/AEEISCore`: the inbox rule, the API client and links, with no UIKit. `swift test` runs its tests on a Mac
  without Xcode; set `AEEIS_E2E_SERVER=http://localhost:<port>` to also run the live-server tests against a running
  AEEIS (for example `npm run demo:local`).
- `App`: the SwiftUI app.
- `project.yml`: the Xcode project, generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen).

## Build

Needs Xcode 16 or later.

```bash
cd apps/ios
brew install xcodegen
xcodegen
open AEEIS.xcodeproj
```

Pick your team under Signing & Capabilities, then run on a simulator or a phone. In the simulator, connect to
`http://localhost:<port>`; any other address must be HTTPS.

## Push

1. In the Apple Developer account, give the app ID `co.x2v.aeeis` the Push Notifications capability and create an APNs
   key (`.p8`).
2. On the server set `AEEIS_APNS_KEY_FILE`, `AEEIS_APNS_KEY_ID`, `AEEIS_APNS_TEAM_ID` and `AEEIS_APNS_BUNDLE_ID=co.x2v.aeeis`.
3. Debug builds register with Apple's sandbox push service and release builds with production; the app tells the
   server which one, so one server can serve both.
