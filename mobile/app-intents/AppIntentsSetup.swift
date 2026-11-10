internal import ExpoAppIntents
internal import ExpoModulesCore

/// Registered Expo inline module that wires the app-target App Intents code
/// (TellAgentIntent.swift) to expo-app-intents. Do not change the name of this
/// class: expo-app-intents finds it by name.
final class AppIntentsSetup: Module {
  public func definition() -> ExpoModulesCore.ModuleDefinition {
    Name("AppIntentsSetup")

    OnCreate {
      // The agents' names reach Siri's phrases ("Tell Inbox in …") when the
      // app publishes its catalog (src/lib/siriBridge.tsx), and on each launch.
      Task {
        await AppIntentDispatcher.shared.setShortcutsRefreshHandler {
          AppShortcuts.updateAppShortcutParameters()
        }
        AppShortcuts.updateAppShortcutParameters()
      }
    }
  }
}
