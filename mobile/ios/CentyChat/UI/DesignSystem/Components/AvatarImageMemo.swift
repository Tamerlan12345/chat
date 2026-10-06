import SwiftUI
import UIKit

/// Decoded avatar photos on the main actor, so an `AvatarView` coming back on screen (a scrolled
/// list, a pushed card) shows the photo in its first frame — no initials flash while the loader's
/// actor answers. Inline `data:image` avatars (older servers) are decoded once, not per body.
///
/// Belongs to the session: `AppContainer.sessionDidEnd` wipes it with the photo cache.
@MainActor
final class AvatarImageMemo {
    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 300
        return cache
    }()

    func image(for key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }

    /// `data:image/…;base64,…`, decoded once.
    func inlineImage(_ dataURL: String) -> UIImage? {
        if let cached = image(for: dataURL) { return cached }
        guard dataURL.hasPrefix("data:image"),
              let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              let decoded = UIImage(data: data) else { return nil }
        store(decoded, for: dataURL)
        return decoded
    }

    func removeAll() {
        cache.removeAllObjects()
    }
}

private struct AvatarMemoKey: EnvironmentKey {
    static let defaultValue: AvatarImageMemo? = nil
}

extension EnvironmentValues {
    /// The session's decoded avatars; without it every `AvatarView` decodes on its own.
    var avatarMemo: AvatarImageMemo? {
        get { self[AvatarMemoKey.self] }
        set { self[AvatarMemoKey.self] = newValue }
    }
}
