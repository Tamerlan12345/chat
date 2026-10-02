package com.openmychat.mobile.features.announcements

import com.openmychat.mobile.data.model.Announcement
import com.openmychat.mobile.data.repository.AnnouncementsRepository
import com.openmychat.mobile.testing.FakeRealtimeRepository
import com.openmychat.mobile.testing.MainDispatcherRule
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Failures are reported, never swallowed. */
class AnnouncementsViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule val mainDispatcher = MainDispatcherRule(dispatcher)

    private val repository = object : AnnouncementsRepository {
        var list = listOf(Announcement(id = 1, authorId = 9, title = "Приказ", content = "Текст"))
        var failLoad = false
        var failAck = false
        override suspend fun announcements(): List<Announcement> {
            if (failLoad) error("offline")
            return list
        }
        override suspend fun acknowledge(id: Long) {
            if (failAck) error("500")
        }
    }

    private fun viewModel() = AnnouncementsViewModel(repository, FakeRealtimeRepository())

    @Test
    fun aFailedAcknowledgementIsReportedAndTheAnnouncementStaysUnconfirmed() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        val content = vm.uiState.value as AnnouncementsUiState.Content
        vm.selectAnnouncement(content.announcements.single())

        repository.failAck = true
        val event = backgroundScope.async { vm.events.first() }
        vm.acknowledgeSelected()
        runCurrent()

        assertEquals(AnnouncementsEvent.AcknowledgeFailed, event.await())
        val after = vm.uiState.value as AnnouncementsUiState.Content
        assertFalse(after.announcements.single().isConfirmed)
        assertFalse(after.isAcknowledging)
        assertEquals("the sheet stays open so the user can retry", 1L, after.selected?.id)
    }

    @Test
    fun aSuccessfulAcknowledgementIsAnnouncedForTheHaptic() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.selectAnnouncement((vm.uiState.value as AnnouncementsUiState.Content).announcements.single())

        val event = backgroundScope.async { vm.events.first() }
        vm.acknowledgeSelected()
        runCurrent()

        assertEquals(AnnouncementsEvent.Acknowledged, event.await())
        assertTrue((vm.uiState.value as AnnouncementsUiState.Content).announcements.single().isConfirmed)
    }

    @Test
    fun aFailedRefreshKeepsTheListAndIsReported() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()

        repository.failLoad = true
        val event = backgroundScope.async { vm.events.first() }
        vm.loadAnnouncements()
        runCurrent()

        assertEquals(AnnouncementsEvent.RefreshFailed, event.await())
        val content = vm.uiState.value as AnnouncementsUiState.Content
        assertEquals(1, content.announcements.size)
        assertFalse(content.isRefreshing)
    }
}
