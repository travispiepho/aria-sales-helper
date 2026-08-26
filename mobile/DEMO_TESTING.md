# ARIA TEST Android APK (testing only)

ARIA TEST is a separately installable, offline/mock navigation build for UI testing. It is **not** an authenticated ARIA client and must not be used for customer work.

## Build

Use only the dedicated profile:

```bash
npx eas-cli build --platform android --profile demo-testing
```

The profile sets `EXPO_PUBLIC_DEMO_MODE=true`. The exact string `true` is required; unset, `false`, and every existing development/preview/production profile use normal production behavior and authentication.

## Isolation guarantees

When demo mode is enabled:

- Android label: **ARIA TEST**
- Android package: `com.prospectrdigital.aria.test` (installs beside `com.prospectrdigital.aria`)
- login is skipped with a local fake `ARIA Tester` profile
- the API request primitive rejects before `fetch`, and the WebSocket base is loopback-only
- Expo Updates are disabled, preventing this binary from accepting the production update stream
- meeting history, transcript, and objections are fixed local sample data
- recording/meeting creation, WebSockets, outbound customer calls, summary generation, profile/password/voice-print changes, and floor scanning are disabled
- no credentials, session IDs, tokens, customer records, or production database content are bundled or requested

## Exact limitations

Safe navigation is available for Home, sample meeting detail/transcript, Objections, meeting setup, recording screen (start disabled), Call a Customer (action disabled), Floor Scan (disabled), proposal mockup, and the local Test Profile.

This build cannot log in or out, synchronize, load real meetings, record/transcribe audio, place calls, scan floors, generate summaries, update a profile/password/voice print, write any server data, or validate backend connectivity. Local form fields may still change in memory for UI testing and are discarded when the app restarts.

## Local verification

```bash
npx expo-doctor
npx tsc --noEmit
EXPO_PUBLIC_DEMO_MODE=true npx expo export --platform android --no-bytecode --output-dir dist-demo-check
EXPO_PUBLIC_DEMO_MODE=true npx expo config --type public
npx expo config --type public
```

For the two config outputs, verify demo resolves to `ARIA TEST` / `com.prospectrdigital.aria.test`, while normal resolves to `ARIA Sales Helper` / `com.prospectrdigital.aria`.
