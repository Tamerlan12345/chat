package com.openmychat.mobile.data.repository

import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.session.SecureStorageUnavailableException
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.BlockedUser
import com.openmychat.mobile.data.model.RegisterRequestBody
import com.openmychat.mobile.data.model.RegistrationChallenge
import com.openmychat.mobile.data.model.RegistrationOutcome
import com.openmychat.mobile.data.model.ReportBody
import com.openmychat.mobile.di.ApplicationScope
import com.openmychat.mobile.features.auth.LoginPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Self-registration, account deletion, reports and blocks (mobile/contracts/registration.md). */
interface AccountRepository {
    /** People the signed-in user blocked, as last known; empty while signed out. */
    val blocked: StateFlow<List<BlockedUser>>

    suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge

    /** Stores the session (as a sign-in does) when the outcome is [RegistrationOutcome.SignedIn]. */
    suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome

    /**
     * Deletes the account on the server (the password is checked there), then wipes this device:
     * the Keystore-backed session, the device secret and the remembered login. Clearing the session
     * also wipes the caches that follow it (people directory, chat history, recents). A failure on the
     * server leaves everything as it was; a local wipe that fails throws [SecureStorageUnavailableException].
     */
    suspend fun deleteAccount(password: String)

    suspend fun report(body: ReportBody)
    suspend fun block(userId: Long, name: String?)
    suspend fun unblock(userId: Long)

    /** Loads the block list from the server and returns it. */
    suspend fun refreshBlocked(): List<BlockedUser>
}

/** Where no account backend is wired (previews, tests of other features): every request is "offline". */
object UnavailableAccountRepository : AccountRepository {
    override val blocked: StateFlow<List<BlockedUser>> = MutableStateFlow(emptyList<BlockedUser>()).asStateFlow()
    private fun offline(): Nothing = throw ApiException(0, "NETWORK_ERROR", "No account backend")
    override suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge = offline()
    override suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome = offline()
    override suspend fun deleteAccount(password: String) = offline()
    override suspend fun report(body: ReportBody) = offline()
    override suspend fun block(userId: Long, name: String?) = offline()
    override suspend fun unblock(userId: Long) = offline()
    override suspend fun refreshBlocked(): List<BlockedUser> = offline()
}

@Singleton
class DefaultAccountRepository @Inject constructor(
    private val api: ApiClient,
    private val session: SessionManager,
    private val loginPreferences: LoginPreferences,
    @ApplicationScope scope: CoroutineScope
) : AccountRepository {

    private val _blocked = MutableStateFlow<List<BlockedUser>>(emptyList())
    override val blocked: StateFlow<List<BlockedUser>> = _blocked.asStateFlow()

    init {
        scope.launch { session.tokenFlow.collect { if (it == null) _blocked.value = emptyList() } }
    }

    override suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge =
        api.requestRegistration(body)

    override suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome {
        val outcome = api.verifyRegistration(registrationId, code)
        if (outcome is RegistrationOutcome.SignedIn) loginPreferences.lastUsername = outcome.user.username
        return outcome
    }

    override suspend fun deleteAccount(password: String) {
        api.deleteAccount(password)
        // The server revoked every token and unbound this device: nothing of the account may stay.
        val cleared = session.clearSession()
        val secretCleared = runCatching { session.deviceSecret = null }.isSuccess
        loginPreferences.lastUsername = null
        if (!cleared || !secretCleared) throw SecureStorageUnavailableException()
    }

    override suspend fun report(body: ReportBody) = api.report(body)

    override suspend fun block(userId: Long, name: String?) {
        api.blockUser(userId)
        _blocked.update { list -> if (list.any { it.id == userId }) list else list + BlockedUser(userId, name) }
    }

    override suspend fun unblock(userId: Long) {
        api.unblockUser(userId)
        _blocked.update { list -> list.filter { it.id != userId } }
    }

    override suspend fun refreshBlocked(): List<BlockedUser> = api.blockedUsers().also { _blocked.value = it }
}
