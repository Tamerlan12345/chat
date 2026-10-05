package com.openmychat.mobile.features.account

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.testing.FakeAccountRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportControllerTest {

    private val account = FakeAccountRepository()
    private val message = ReportTarget(ReportTargetType.MESSAGE, id = 77, subject = "Боб: купите слона")

    @Test
    fun aReportSendsTheReasonCodeAndNoEmptyDetails() = runTest(UnconfinedTestDispatcher()) {
        val reports = ReportController(account, backgroundScope) { 0L }
        reports.open(message)
        assertEquals(ReportReason.SPAM, reports.sheet.value?.reason)

        reports.selectReason(ReportReason.THREAT)
        reports.updateDetails("   ")
        reports.send()

        assertEquals(ReportBody(ReportTargetType.MESSAGE, 77, "threat", null), account.reports.single())
        assertTrue(reports.sheet.value!!.sent)
    }

    @Test
    fun detailsAreTrimmedAndCappedAtAThousandCharacters() = runTest(UnconfinedTestDispatcher()) {
        val reports = ReportController(account, backgroundScope) { 0L }
        reports.open(ReportTarget(ReportTargetType.USER, id = 7, subject = "Боб"))

        reports.updateDetails("x".repeat(1_500))
        assertEquals(1_000, reports.sheet.value!!.details.length)
        reports.updateDetails("  писал ночью  ")
        reports.send()

        assertEquals(ReportBody(ReportTargetType.USER, 7, "spam", "писал ночью"), account.reports.single())
    }

    @Test
    fun aFailureStaysOnTheSheetAndCanBeRetried() = runTest(UnconfinedTestDispatcher()) {
        account.onReport = { throw ApiException(429, null, "Слишком много жалоб", retryAfterSeconds = 600) }
        var now = 5_000L
        val reports = ReportController(account, backgroundScope) { now }
        reports.open(message)

        reports.send()

        val sheet = reports.sheet.value!!
        assertEquals(AccountFailure.Throttled(605_000L), sheet.failure)
        assertFalse(sheet.sent)
        assertFalse(sheet.sending)

        account.onReport = {}
        reports.send()
        assertFalse("«Отправить жалобу» waits out the server's 429", reports.sheet.value!!.sent)
        assertEquals(1, account.reports.size)

        now = 605_000L
        reports.send()
        assertTrue(reports.sheet.value!!.sent)
        assertNull(reports.sheet.value!!.failure)
    }

    @Test
    fun oneReportAtATimeAndClosingForgetsIt() = runTest(UnconfinedTestDispatcher()) {
        val gate = CompletableDeferred<Unit>()
        account.onReport = { gate.await() }
        val reports = ReportController(account, backgroundScope) { 0L }
        reports.open(message)

        reports.send()
        reports.send()
        gate.complete(Unit)

        assertEquals(1, account.reports.size)
        reports.dismiss()
        assertNull(reports.sheet.value)
    }

    @Test
    fun theSheetKnowsWhenSendingIsAllowedAgain() = runTest(UnconfinedTestDispatcher()) {
        account.onReport = { throw ApiException(429, null, "Слишком много жалоб", retryAfterSeconds = 60) }
        val reports = ReportController(account, backgroundScope) { 0L }
        reports.open(message)
        reports.send()

        val sheet = reports.sheet.value!!
        assertFalse(sheet.canSendAt(59_000L))
        assertTrue(sheet.canSendAt(60_000L))
    }

    @Test
    fun aCancelledReportIsNotAFailure() = runTest(UnconfinedTestDispatcher()) {
        account.onReport = { throw kotlinx.coroutines.CancellationException("closed") }
        val reports = ReportController(account, backgroundScope) { 0L }
        reports.open(message)

        reports.send()

        assertNull(reports.sheet.value!!.failure)
        assertFalse(reports.sheet.value!!.sending)
    }
}
