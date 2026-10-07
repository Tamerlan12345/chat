import Foundation
import XCTest
@testable import CentyChat

/// «был(а) в сети», safe `tel:`/`mailto:` links and the person card's actions.
final class PresenceLineTests: XCTestCase {
    private let almaty = TimeZone(identifier: "Asia/Almaty")!

    /// 2026-10-02 18:00 in Almaty (UTC+5).
    private var now: Date { PresenceLine.parse("2026-10-02T13:00:00.000Z")! }

    private func line(_ status: UserStatus, _ lastSeen: String?) -> PresenceLine {
        PresenceLine.of(status: status, lastSeen: PresenceLine.parse(lastSeen), now: now, timeZone: almaty)
    }

    func testLiveStatusesWinOverLastSeen() {
        XCTAssertEqual(line(.online, "2026-10-01T09:00:00.000Z"), .online)
        XCTAssertEqual(line(.away, nil), .away)
        XCTAssertEqual(line(.dnd, nil), .doNotDisturb)
    }

    func testOfflineTodayShowsTheLocalTime() {
        XCTAssertEqual(line(.offline, "2026-10-02T09:32:00.000Z"), .seenToday("14:32"))
        XCTAssertEqual(line(.offline, "2026-10-02T09:32:00.000Z").text, "Был(а) в сети сегодня в 14:32")
    }

    func testOfflineYesterdayShowsYesterday() {
        XCTAssertEqual(line(.offline, "2026-10-01T18:10:00.000Z"), .seenYesterday("23:10"))
        XCTAssertEqual(line(.offline, "2026-10-01T18:10:00.000Z").text, "Был(а) в сети вчера в 23:10")
    }

    func testOlderDatesShowDayAndShortMonth() {
        XCTAssertEqual(line(.offline, "2026-09-12T08:00:00.000Z"), .seenOn("12 сент."))
        XCTAssertEqual(line(.offline, "2025-05-03T08:00:00.000Z"), .seenOn("3 мая 2025"))
        XCTAssertEqual(line(.offline, "2026-09-12T08:00:00.000Z").text, "Был(а) в сети 12 сент.")
    }

    func testSqliteTimestampsAreUtcToo() {
        XCTAssertEqual(line(.offline, "2026-10-02 09:32:00"), .seenToday("14:32"))
    }

    func testUnknownOrFutureLastSeenFallsBackToOffline() {
        XCTAssertEqual(line(.offline, nil), .offline)
        XCTAssertEqual(line(.offline, "garbage"), .offline)
        XCTAssertEqual(line(.offline, "2027-01-01T00:00:00.000Z"), .offline)
        XCTAssertEqual(PresenceLine.offline.text, "Не в сети")
    }
}

final class ContactLinksTests: XCTestCase {
    func testPhonesKeepOnlyDigitsAndTheLeadingPlus() {
        XCTAssertEqual(ContactLinks.phoneNumber("+7 (700) 123-45-14"), "+77001234514")
        XCTAssertEqual(ContactLinks.phoneNumber("8 701 222 33 44"), "87012223344")
        XCTAssertEqual(ContactLinks.dial("+7 (700) 123-45-14")?.absoluteString, "tel:+77001234514")
    }

    func testAnythingThatIsNotAPhoneIsNotDialled() {
        XCTAssertNil(ContactLinks.phoneNumber("12"))
        XCTAssertNil(ContactLinks.phoneNumber("+7 701;ussd*#"))
        XCTAssertNil(ContactLinks.phoneNumber("позвоните секретарю"))
        XCTAssertNil(ContactLinks.dial("*#06#"))
    }

    func testEmailsMustLookLikeAnAddressWithoutExtraParameters() {
        XCTAssertEqual(ContactLinks.email(" p.ivanov@example.com "), "p.ivanov@example.com")
        XCTAssertEqual(ContactLinks.mail("p.ivanov@example.com")?.absoluteString, "mailto:p.ivanov@example.com")
        XCTAssertNil(ContactLinks.email("a@example.com?subject=x&body=y"))
        XCTAssertNil(ContactLinks.mail("a@example.com?subject=x&body=y"))
        XCTAssertNil(ContactLinks.email("не адрес"))
        XCTAssertNil(ContactLinks.email("a@b"))
        XCTAssertNil(ContactLinks.email("a@b@example.com"))
    }
}

@MainActor
final class PersonCardModelTests: XCTestCase {
    private let bob = Person(id: 8, fullName: "Боб Тестов", phone: "+7 700 000 00 00", status: .online)
    private let requests = PeopleRequests()

    private func model(
        _ people: FakePeopleDirectory,
        me: User? = TestModels.me,
        userId: Int64 = 8,
        woke: Locked<[Int64]> = Locked([])
    ) -> PersonCardModel {
        PersonCardModel(
            userId: userId,
            directory: people,
            currentUser: { me },
            requests: requests,
            sendWake: { id in woke.withValue { $0.append(id) } }
        )
    }

    func testCallingNeedsOwnPermissionAndAReachablePeer() {
        let allowed = RolePermissions(canCall: true)
        let denied = RolePermissions(canCall: false)
        XCTAssertEqual(CallAvailability.of(allowed, peerStatus: .online), .available)
        XCTAssertEqual(CallAvailability.of(allowed, peerStatus: .away), .available)
        XCTAssertEqual(CallAvailability.of(allowed, peerStatus: .dnd), .peerDoNotDisturb, "The server answers call_unavailable")
        XCTAssertEqual(CallAvailability.of(allowed, peerStatus: .offline), .peerOffline)
        XCTAssertEqual(CallAvailability.of(denied, peerStatus: .online), .notPermitted)
        XCTAssertEqual(CallAvailability.of(denied, peerStatus: .dnd), .notPermitted, "The permission comes before DND")
        XCTAssertEqual(CallAvailability.of(nil, peerStatus: .online), .available, "No permissions in the session: the server decides")
        XCTAssertEqual(CallAvailability.peerDoNotDisturb.reason, "Не беспокоить — звонок не пройдёт")
        XCTAssertEqual(CallAvailability.notPermitted.reason, "Звонки недоступны для вашей роли")
        XCTAssertNil(CallAvailability.available.reason)
    }

    func testTheCardShowsTheKnownPersonAndRefreshesIt() async {
        let people = FakePeopleDirectory([bob])
        var fresh = bob
        fresh.jobTitle = "Инженер"
        people.fresh = fresh
        let card = model(people)
        XCTAssertEqual(card.person?.fullName, "Боб Тестов")
        XCTAssertNil(card.person?.jobTitle)

        await card.load()
        XCTAssertEqual(card.person?.jobTitle, "Инженер")
    }

    func testPresenceChangesReachTheOpenCard() {
        let people = FakePeopleDirectory([bob])
        let card = model(people)
        XCTAssertEqual(card.call, .available)
        var gone = bob
        gone.status = .dnd
        people.state.people = [gone]
        XCTAssertEqual(card.call, .peerDoNotDisturb)
    }

    func testTheCallerPermissionComesFromTheOwnSession() {
        var me = TestModels.me
        me.permissions = RolePermissions(canCall: false)
        XCTAssertEqual(model(FakePeopleDirectory([bob]), me: me).call, .notPermitted)
    }

    func testTheOwnCardIsMarkedSoTheActionsBecomeEditProfile() {
        var me = TestModels.me
        me.jobTitle = "Аналитик"
        let card = model(FakePeopleDirectory([]), me: me, userId: me.id)
        XCTAssertTrue(card.isSelf)
        XCTAssertEqual(card.person?.fullName, me.fullName)
        XCTAssertEqual(card.person?.jobTitle, "Аналитик")
    }

    func testTheDepartmentRowAsksThePeopleTabForThatBranch() {
        var inDepartment = bob
        inDepartment.departmentId = 4
        let card = model(FakePeopleDirectory([inDepartment]))
        let before = requests.serial
        card.showDepartment()
        XCTAssertEqual(requests.pending, .department(4))
        XCTAssertEqual(requests.serial, before + 1)
    }

    func testAFormerEmployeeFetchedFromTheServerIsShownAsInactive() async {
        let people = FakePeopleDirectory([])
        var former = bob
        former.isActive = false
        people.fresh = former
        let card = model(people)
        await card.load()
        XCTAssertTrue(card.inactive)
    }

    func testWakingSendsOnceAndStartsTheCooldown() async {
        let woke = Locked<[Int64]>([])
        let card = model(FakePeopleDirectory([bob]), woke: woke)
        card.wake()
        card.wake()
        XCTAssertTrue(card.wakeCooldown > 0)
        let sent = await eventually { woke.value == [8] }
        XCTAssertTrue(sent, "One wake, not two: \(woke.value)")
    }
}

/// In-memory directory for the people models.
@MainActor
final class FakePeopleDirectory: PeopleProviding {
    var state: PeopleState
    var fresh: Person?
    private(set) var refreshes = 0

    init(_ people: [Person], tree: OrgTree? = OrgTree(), selfPerson: Person? = nil) {
        state = PeopleState(people: people, selfPerson: selfPerson, tree: tree, isLoaded: true)
    }

    func refresh() {
        refreshes += 1
    }

    func refreshAndWait() async {
        refresh()
    }

    func person(id: Int64) async -> Person? {
        if let fresh {
            state.people = state.people.map { $0.id == id ? fresh : $0 }
        }
        return fresh
    }
}
