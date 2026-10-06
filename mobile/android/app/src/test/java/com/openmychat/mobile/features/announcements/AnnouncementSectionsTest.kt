package com.openmychat.mobile.features.announcements

import com.openmychat.mobile.data.model.Announcement
import org.junit.Assert.assertEquals
import org.junit.Test

/** The grouped announcements list: what still needs «Ознакомлен» first, server order kept inside. */
class AnnouncementSectionsTest {

    private fun ann(id: Long, confirmed: Boolean) = Announcement(id = id, authorId = 1, title = "№$id", content = "", isConfirmed = confirmed)

    @Test
    fun openAnnouncementsComeFirstInTheirOwnSection() {
        val sections = AnnouncementSections.of(listOf(ann(1, true), ann(2, false), ann(3, true), ann(4, false)))

        assertEquals(listOf(AnnouncementSections.Kind.NEEDS_ACK, AnnouncementSections.Kind.READ), sections.map { it.kind })
        assertEquals(listOf(2L, 4L), sections[0].items.map { it.id })
        assertEquals(listOf(1L, 3L), sections[1].items.map { it.id })
    }

    @Test
    fun anEmptySectionIsLeftOut() {
        assertEquals(listOf(AnnouncementSections.Kind.READ), AnnouncementSections.of(listOf(ann(1, true))).map { it.kind })
        assertEquals(emptyList<AnnouncementSections.Section>(), AnnouncementSections.of(emptyList()))
    }
}
