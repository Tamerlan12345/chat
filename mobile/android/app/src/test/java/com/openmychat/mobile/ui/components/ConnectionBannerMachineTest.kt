package com.openmychat.mobile.ui.components

import com.openmychat.mobile.ui.components.BannerState.BackOnline
import com.openmychat.mobile.ui.components.BannerState.Hidden
import com.openmychat.mobile.ui.components.BannerState.Problem
import org.junit.Assert.assertEquals
import org.junit.Test

/** «Нет сети» / «Переподключение…» / «Снова в сети» (collapses after 1.2 s). */
class ConnectionBannerMachineTest {

    @Test
    fun aProblemShowsAndItsKindCanChange() {
        assertEquals(Problem(LinkProblem.RECONNECTING), ConnectionBannerMachine.onLink(Hidden, LinkProblem.RECONNECTING))
        assertEquals(Problem(LinkProblem.OFFLINE), ConnectionBannerMachine.onLink(Problem(LinkProblem.RECONNECTING), LinkProblem.OFFLINE))
    }

    @Test
    fun recoveryAfterAProblemSaysBackOnlineThenHides() {
        assertEquals(BackOnline, ConnectionBannerMachine.onLink(Problem(LinkProblem.OFFLINE), null))
        assertEquals(Hidden, ConnectionBannerMachine.onBackOnlineElapsed(BackOnline))
        assertEquals(1_200L, ConnectionBannerMachine.BACK_ONLINE_MILLIS)
    }

    @Test
    fun aHealthyLinkNeverAnnouncesItself() {
        assertEquals(Hidden, ConnectionBannerMachine.onLink(Hidden, null))
        assertEquals(BackOnline, ConnectionBannerMachine.onLink(BackOnline, null))
    }

    @Test
    fun aNewProblemInterruptsBackOnline() {
        assertEquals(Problem(LinkProblem.OFFLINE), ConnectionBannerMachine.onLink(BackOnline, LinkProblem.OFFLINE))
    }

    @Test
    fun theTimerOnlyClosesBackOnline() {
        assertEquals(Problem(LinkProblem.OFFLINE), ConnectionBannerMachine.onBackOnlineElapsed(Problem(LinkProblem.OFFLINE)))
        assertEquals(Hidden, ConnectionBannerMachine.onBackOnlineElapsed(Hidden))
    }
}
