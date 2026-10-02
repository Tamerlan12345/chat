import CoreGraphics
import SwiftUI
import XCTest
@testable import CentyChat

/// The "c" glyph matches the desktop `BRAND_C_PATH` geometry (880×880 viewBox).
final class BrandMarkTests: XCTestCase {
    func testGlyphBoundsMatchTheDesktopPath() {
        let bounds = BrandCShape().path(in: CGRect(x: 0, y: 0, width: 880, height: 880)).boundingRect

        XCTAssertEqual(bounds.minX, 329.8, accuracy: 0.01)
        XCTAssertEqual(bounds.minY, 190, accuracy: 0.01)
        XCTAssertEqual(bounds.maxX, 619.8, accuracy: 0.01)
        XCTAssertEqual(bounds.maxY, 690, accuracy: 0.01)
    }

    func testGlyphIsAnOpenRingNotABlock() {
        let path = BrandCShape().path(in: CGRect(x: 0, y: 0, width: 880, height: 880))

        XCTAssertTrue(path.contains(CGPoint(x: 360, y: 440)), "Left stroke")
        XCTAssertTrue(path.contains(CGPoint(x: 560, y: 220)), "Top arm")
        XCTAssertTrue(path.contains(CGPoint(x: 560, y: 660)), "Bottom arm")
        XCTAssertFalse(path.contains(CGPoint(x: 520, y: 440)), "Counter of the c")
        XCTAssertFalse(path.contains(CGPoint(x: 340, y: 200)), "Rounded outer corner")
    }

    func testGlyphScalesWithTheMark() {
        let bounds = BrandCShape().path(in: CGRect(x: 0, y: 0, width: 72, height: 72)).boundingRect

        XCTAssertEqual(bounds.minX, 329.8 * 72 / 880, accuracy: 0.01)
        XCTAssertEqual(bounds.height, 500 * 72 / 880, accuracy: 0.01)
    }
}
