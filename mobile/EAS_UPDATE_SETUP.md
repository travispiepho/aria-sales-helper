# EAS Update activation

The repository contains the local scaffolding for Expo's over-the-air (OTA) update service, but it is **not active yet**. Activation requires an Expo account, a real EAS project ID, and one new native build per platform. Decide whether the project belongs under Gabe's or Travis's existing Expo account/organization; if neither has one, create an Expo account and organization owned by the business rather than by an individual developer.

## One-time activation

Run these commands from `app/mobile/` on a developer machine:

1. Sign in to the chosen Expo account:

   ```bash
   npx expo login
   npx eas-cli@latest whoami
   ```

2. Link this app to a new or existing EAS project:

   ```bash
   npx eas-cli@latest init
   ```

   Choose the intended account/organization when prompted. This adds the real `expo.extra.eas.projectId` to `app.json`; do not invent an ID.

3. Finish the update configuration:

   ```bash
   npx eas-cli@latest update:configure
   ```

   Confirm that `expo.updates.url` in `app.json` is now `https://u.expo.dev/<real-project-UUID>` and that the checked-in `REPLACE_WITH_EAS_PROJECT_ID` placeholder is gone. Keep the existing `runtimeVersion: { "policy": "appVersion" }` setting. It is a simple, explicit fit for this small internal app: JS and asset updates remain compatible within an app version, while a native dependency/config change requires incrementing `expo.version` and making a fresh build. Expo's `fingerprint` policy is more automatic but creates more runtime versions and operational complexity than this app currently needs.

4. Commit the real project-linkage changes, then make the first native production builds so the installed clients include `expo-updates` and know the project URL:

   ```bash
   npx eas-cli@latest build --platform all --profile production
   ```

   Complete any Android/iOS signing prompts and install or distribute those new builds. Devices running older builds cannot receive EAS updates because they do not contain the update client/configuration.

## Shipping later JS/asset-only fixes

After merging and testing a fix, publish it to the same channel as the installed build:

```bash
npx eas-cli@latest update --channel production --message "Describe the fix"
```

For testers using a preview build, build and update the `preview` channel instead:

```bash
npx eas-cli@latest build --platform all --profile preview
npx eas-cli@latest update --channel preview --message "Describe the test fix"
```

EAS Update is only for JavaScript and bundled asset changes. Any native dependency, config-plugin, permissions, SDK, or other native configuration change requires incrementing the app version as appropriate and creating a new EAS build. Test OTA updates on the preview channel before promoting the same change to production.
