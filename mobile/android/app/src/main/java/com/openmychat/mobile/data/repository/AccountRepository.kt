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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
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
    suspend fun deleteAccount(password: String, afterServerDeletion: suspend () -> Unit = {})

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
    override suspend fun deleteAccount(password: String, afterServerDeletion: suspend () -> Unit) = offline()
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

    /** The block list load started by the current session (tests wait for it). */
    internal var sessionLoad: Job? = null
        private set

    init {
        // Every session starts with the server's block list (made earlier, or on another device), like iOS
        // on sign-in; a refreshed token is the same session. Signing out forgets the list.
        scope.launch {
            session.tokenFlow.map { it != null }.distinctUntilChanged().collect { signedIn ->
                sessionLoad?.cancel()
                if (signedIn) {
                    sessionLoad = scope.launch {
                        try {
                            refreshBlocked()
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            // Offline or refused: the profile's list retries; sends still meet DM_NOT_ALLOWED.
                        }
                    }
                } else {
                    sessionLoad = null
                    _blocked.value = emptyList()
                }
            }
        }
    }

    override suspend fun requestRegistration(body: RegisterRequestBody): RegistrationChallenge =
        api.requestRegistration(body)

    override suspend fun verifyRegistration(registrationId: String, code: String): RegistrationOutcome {
        val outcome = api.verifyRegistration(registrationId, code)
        if (outcome is RegistrationOutcome.SignedIn) {
            loginPreferences.lastUsername = outcome.user.username
            // Signed in exactly like a password sign-in: the device is claimed too (parity P8).
            claimThisDevice(api, session)
        }
        return outcome
    }

    override suspend fun deleteAccount(password: String, afterServerDeletion: suspend () -> Unit) {
        api.deleteAccount(password)
        // The server deleted the account: what follows runs whatever the local clear below does.
        afterServerDeletion()
        // The server revoked every token and unbound this device: nothing of the account may stay.
        val cleared = session.clearSessionForSignOut()
        loginPreferences.lastUsername = null
        if (!cleared) throw SecureStorageUnavailableException()
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
