/**
 * withIosSceneLifecycle
 *
 * Adopts the UIScene lifecycle on iOS. iOS 27 **aborts** apps built with the
 * iOS 27 SDK that still run the application-level lifecycle: the device crash
 * (EXC_BREAKPOINT in `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycle-
 * Adoption`, fired from `workspace:didCreateScene:` during launch) is what
 * killed the first TestFlight build on 2026-09-19. React Native 0.86 and Expo
 * SDK 57 ship no scene support of their own, so this plugin performs the
 * minimal adoption:
 *
 *   1. `withAppDelegate` — AppDelegate gains `UIWindowSceneDelegate`
 *      conformance and returns a UISceneConfiguration whose delegate is a new
 *      SceneDelegate class (declared at the bottom of the same file). The
 *      window creation + React boot move from `didFinishLaunchingWithOptions`
 *      into the scene's `willConnectTo` (the factory's `inWindow:` entry
 *      point takes any window). Cold-start launch options are stashed by the
 *      app delegate and forwarded from the scene, so notification/deep-link
 *      cold starts keep their intents.
 *   2. The `UIApplicationSceneManifest` itself is declarative and lives in
 *      `app.json` under `expo.ios.infoPlist` — no plist mod needed here.
 *
 * Why a config plugin: `apps/mobile/ios/` is CNG-generated and gitignored;
 * anything hand-written into it dies on the next `expo prebuild`. This file
 * is the version-control home of the change (same doctrine as
 * withAndroidReleaseSigning).
 *
 * The surgery is anchor-based and THROWS when an anchor is missing — a
 * silent no-op here would put a startup-aborting build on testers' devices.
 */
// `expo/config-plugins` (the expo package's subpath) rather than the
// transitive `@expo/config-plugins`: pnpm's isolated linker only resolves
// direct dependencies from apps/mobile/plugins, and this file is evaluated
// inside the EXConstants build phase too (expo-constants re-evaluates the
// app config), where nothing else is on the resolution path.
const { withAppDelegate } = require('expo/config-plugins');

const CONFORMANCE_ANCHOR = 'class AppDelegate: ExpoAppDelegate {';
const CONFORMANCE = 'class AppDelegate: ExpoAppDelegate, UIWindowSceneDelegate {';

const FACTORY_PROP_ANCHOR = '  var reactNativeFactory: RCTReactNativeFactory?';
const LAUNCH_OPTIONS_PROP =
  '  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?';

const BOOT_BLOCK_ANCHOR = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

`;

const LINKING_ANCHOR = '  // Linking API';
const CONFIG_OVERRIDE = `  // iOS 27 aborts apps built with the iOS 27 SDK that still run the
  // application-level lifecycle — the runtime issue traps at scene creation
  // (the first TestFlight build died exactly here). Adopt UIScene: the scene
  // delegate owns the window and boots React.
  func application(
    _ application: UIApplication,
    configurationForConnecting sceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: nil, sessionRole: sceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

`;

const SCENE_DELEGATE = `
// The UIScene delegate: owns the window and boots React into it through the
// factory's inWindow entry point. Cold-start launch options (notification
// taps, deep links) are stashed by the app delegate and forwarded here, so
// those intents survive the lifecycle change.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    let window = UIWindow(windowScene: windowScene)
    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions)
    self.window = window
    window.makeKeyAndVisible()
  }

  // Warm deep links: scene-based apps deliver URLs here, and RN's Linking
  // module listens through RCTLinkingManager.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        open: context.url,
        options: options)
    }
  }
}
`;

function replaceOnce(contents, anchor, replacement, what) {
  if (!contents.includes(anchor)) {
    throw new Error(`withIosSceneLifecycle: anchor not found in AppDelegate.swift (${what})`);
  }
  return contents.replace(anchor, replacement);
}

const withIosSceneLifecycle = (config) => {
  return withAppDelegate(config, (config) => {
    // SDK 57's ios.appDelegate mod carries modResults as { path, contents }.
    let contents = config.modResults.contents;

    contents = replaceOnce(contents, CONFORMANCE_ANCHOR, CONFORMANCE, 'class declaration');
    contents = replaceOnce(
      contents,
      FACTORY_PROP_ANCHOR,
      `${FACTORY_PROP_ANCHOR}\n${LAUNCH_OPTIONS_PROP}`,
      'launch-options property',
    );
    contents = replaceOnce(contents, BOOT_BLOCK_ANCHOR, '', 'legacy boot block');
    contents = replaceOnce(contents, LINKING_ANCHOR, `${CONFIG_OVERRIDE}${LINKING_ANCHOR}`, 'scene configuration');
    contents = contents + SCENE_DELEGATE;

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = withIosSceneLifecycle;
