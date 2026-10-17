import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // HealthKit may relaunch us in the background to deliver new samples;
        // observer queries must be registered before the UI exists.
        Task { @MainActor in
            AppModel.shared.startBackgroundObservers()
        }
        return true
    }
}

@main
struct AutoHealthApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.settings)
                .task { await model.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active, model.authState == .ready {
                        Task { await model.refresh(reason: .foreground) }
                    }
                }
        }
    }
}
