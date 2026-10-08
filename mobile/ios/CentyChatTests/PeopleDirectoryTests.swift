import Foundation
import XCTest
@testable import CentyChat

/// Who the directory lists, the «Отделы» tree, the A–Я sections and the department outline.
final class PeopleDirectoryTests: XCTestCase {
    private func user(
        _ id: Int64,
        _ name: String,
        department: Int64? = nil,
        departmentName: String? = nil,
        status: UserStatus = .offline,
        isActive: Bool = true
    ) -> PublicUser {
        PublicUser(
            id: id,
            username: "u\(id)",
            fullName: name,
            departmentId: department,
            departmentName: departmentName,
            status: status,
            isActive: isActive
        )
    }

    private func person(_ id: Int64, _ name: String, department: Int64? = nil, status: UserStatus = .offline) -> Person {
        Person(id: id, fullName: name, departmentId: department, status: status)
    }

    private let tree = OrgTree(tree: [
        OrgDepartment(id: 1, name: "Головной офис", subDepartments: [
            OrgDepartment(id: 2, name: "Бухгалтерия"),
            OrgDepartment(id: 3, name: "ИТ"),
        ]),
        OrgDepartment(id: 4, name: "Филиал"),
    ])

    func testOnlyActiveColleaguesAreListedAndNeverYourself() {
        let people = PeopleDirectory.people(
            users: [user(1, "Я Сам"), user(2, "Коллега Активный"), user(3, "Уволенный Сотрудник", isActive: false)],
            tree: nil,
            selfId: 1
        )
        XCTAssertEqual(people.map(\.id), [2])
    }

    func testDepartmentNamesComeFromTheTreeWhenTheListLacksThem() {
        let people = PeopleDirectory.people(
            users: [user(2, "Бух Один", department: 2), user(3, "Без Дерева", department: 99, departmentName: "Старое имя")],
            tree: tree,
            selfId: nil
        )
        XCTAssertEqual(people.first { $0.id == 2 }?.departmentName, "Бухгалтерия")
        XCTAssertEqual(people.first { $0.id == 3 }?.departmentName, "Старое имя")
    }

    func testOnlineMeansOnlineOrAwayLikeTheDesktop() {
        XCTAssertTrue(UserStatus.online.isReachable)
        XCTAssertTrue(UserStatus.away.isReachable)
        XCTAssertFalse(UserStatus.dnd.isReachable)
        XCTAssertFalse(UserStatus.offline.isReachable)
        let people = [person(1, "А", status: .online), person(2, "Б", status: .away), person(3, "В", status: .dnd)]
        XCTAssertEqual(PeopleDirectory.onlineCount(people), 2)
    }

    func testTheTreeHoldsPeopleUnderTheirDepartmentsWithCountsAndUnassignedLast() {
        let people = [
            person(1, "Директор", department: 1, status: .online),
            person(2, "Бух Один", department: 2, status: .away),
            person(3, "Бух Два", department: 2),
            person(4, "Айтишник", department: 3),
            person(6, "Новичок"),
        ]
        let nodes = PeopleDirectory.departments(tree: tree, people: people)
        XCTAssertEqual(nodes.map(\.name), ["Головной офис", "Филиал", PeopleDirectory.unassignedName])
        XCTAssertEqual(nodes[0].total, 4)
        XCTAssertEqual(nodes[0].online, 2)
        XCTAssertEqual(nodes[0].people.map(\.fullName), ["Директор"])
        XCTAssertEqual(nodes[0].children.map(\.total), [2, 1])
        XCTAssertEqual(nodes[1].total, 0)
        XCTAssertEqual(nodes[2].people.map(\.id), [6])
        XCTAssertTrue(nodes[2].isUnassigned)
    }

    func testFilteringKeepsMatchingBranchesAndAWholeDepartmentWhoseNameMatches() {
        let people = [
            person(1, "Директор", department: 1),
            person(2, "Бух Один", department: 2),
            person(3, "Бух Два", department: 2, status: .online),
            person(4, "Айтишник", department: 3),
        ]
        let nodes = PeopleDirectory.departments(tree: tree, people: people)

        let byName = PeopleDirectory.filter(nodes, query: "айти", onlineOnly: false)
        XCTAssertEqual(byName.map(\.name), ["Головной офис"])
        XCTAssertEqual(byName[0].children.map(\.name), ["ИТ"])

        let byDepartment = PeopleDirectory.filter(nodes, query: "бухгал", onlineOnly: false)
        XCTAssertEqual(byDepartment[0].children[0].people.map(\.fullName).sorted(), ["Бух Два", "Бух Один"])

        let online = PeopleDirectory.filter(nodes, query: "", onlineOnly: true)
        XCTAssertEqual(online[0].children.count, 1)
        XCTAssertEqual(online[0].children[0].people.map(\.fullName), ["Бух Два"])
        XCTAssertEqual(online[0].total, 4, "Counters describe the whole department, not the filtered view")
    }

    func testPathLeadsFromTheRootToTheDepartment() {
        let nodes = PeopleDirectory.departments(tree: tree, people: [person(2, "Бух", department: 2)])
        XCTAssertEqual(PeopleDirectory.path(to: 2, in: nodes), [1, 2])
        XCTAssertEqual(PeopleDirectory.path(to: 42, in: nodes), [])
    }

    func testSectionsAreCyrillicFirstThenLatinThenOther() {
        let sections = PeopleDirectory.sections([
            person(1, "Яковлев Ян"),
            person(2, "Smith John"),
            person(3, "Еремеев Олег"),
            person(4, "Ёлкин Пётр"),
            person(5, "Абрамова Анна"),
            person(6, "007"),
        ])
        XCTAssertEqual(sections.map(\.letter), ["А", "Е", "Я", "S", "#"])
        XCTAssertEqual(sections[1].people.map(\.fullName), ["Ёлкин Пётр", "Еремеев Олег"])
    }

    func testTheSummaryLineUsesRussianPlurals() {
        XCTAssertEqual(RussianPlural.peopleSummary(total: 48, online: 12), "48 сотрудников · 12 в сети")
        XCTAssertEqual(RussianPlural.peopleSummary(total: 1, online: 0), "1 сотрудник · 0 в сети")
        XCTAssertEqual(RussianPlural.peopleSummary(total: 3, online: 1), "3 сотрудника · 1 в сети")
        XCTAssertEqual(RussianPlural.peopleSummary(total: 11, online: 0), "11 сотрудников · 0 в сети")
        XCTAssertEqual(RussianPlural.peopleSummary(total: 22, online: 2), "22 сотрудника · 2 в сети")
    }

    // MARK: - Outline («Отделы» as rows)

    func testTheOutlineShowsSubdepartmentsFirstThenPeopleIndentedUnderExpandedDepartments() {
        let nodes = PeopleDirectory.departments(tree: tree, people: [
            person(1, "Директор", department: 1),
            person(2, "Бух Один", department: 2),
        ])
        let rows = DepartmentOutline.rows(nodes, expanded: [1, 2])
        XCTAssertEqual(rows.map(\.debugDescription), [
            "d1@0+", "d2@1+", "p2@2", "d3@1-", "p1@1", "d4@0-",
        ])
    }

    func testCollapsedDepartmentsHideTheirWholeBranch() {
        let nodes = PeopleDirectory.departments(tree: tree, people: [person(2, "Бух Один", department: 2)])
        XCTAssertEqual(DepartmentOutline.rows(nodes, expanded: []).map(\.debugDescription), ["d1@0-", "d4@0-"])
    }

    func testTheSamePersonGetsDistinctRowIdsInDifferentPlaces() {
        let nodes = [
            DepartmentNode(id: 1, name: "А", children: [], people: [person(5, "Сам")], total: 1, online: 0),
            DepartmentNode(id: 2, name: "Б", children: [], people: [person(5, "Сам")], total: 1, online: 0),
        ]
        let ids = DepartmentOutline.rows(nodes, expanded: [1, 2]).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }
}
