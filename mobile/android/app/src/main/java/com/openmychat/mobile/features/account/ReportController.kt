package com.openmychat.mobile.features.account

import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.data.repository.AccountRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What a report is about; [subject] is shown on the sheet (a name or a message excerpt). */
data class ReportTarget(val type: ReportTargetType, val id: Long, val subject: String)

/** Reason codes go to the server (`reason`), the sheet shows Russian titles. Same set as iOS. */
enum class ReportReason(val code: String) {
    SPAM("spam"),
    ABUSE("abuse"),
    INAPPROPRIATE("inappropriate"),
    THREAT("threat"),
    OTHER("other")
}

/** The report sheet: open while non-null. */
data class ReportSheetState(
    val target: ReportTarget,
    val reason: ReportReason = ReportReason.SPAM,
    val details: String = "",
    val sending: Boolean = false,
    val failure: AccountFailure? = null,
    val sent: Boolean = false
)

/**
 * «Пожаловаться» on a person or a message (`POST /api/reports`). One instance per screen that offers
 * reports (the person card, a chat); it lives in that screen's ViewModel scope.
 */
class ReportController(
    private val account: AccountRepository,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis
) {
    private val _sheet = MutableStateFlow<ReportSheetState?>(null)
    val sheet: StateFlow<ReportSheetState?> = _sheet.asStateFlow()

    fun open(target: ReportTarget) {
        _sheet.value = ReportSheetState(target)
    }

    fun selectReason(reason: ReportReason) = _sheet.update { it?.copy(reason = reason) }

    fun updateDetails(text: String) = _sheet.update { it?.copy(details = text.take(DETAILS_LIMIT)) }

    fun send() {
        val current = _sheet.value ?: return
        if (current.sending || current.sent) return
        _sheet.value = current.copy(sending = true, failure = null)
        val details = current.details.trim().takeIf { it.isNotEmpty() }
        val body = ReportBody(current.target.type, current.target.id, current.reason.code, details)
        scope.launch {
            val failure = try {
                account.report(body)
                null
            } catch (error: Exception) {
                AccountFailure.from(error, AccountFailure.Context.GENERIC, clock())
            }
            _sheet.update { it?.copy(sending = false, failure = failure, sent = failure == null) }
        }
    }

    fun dismiss() {
        _sheet.value = null
    }

    companion object {
        /** iOS caps details at 1000 characters (the server accepts up to 2000). */
        const val DETAILS_LIMIT = 1_000
    }
}
