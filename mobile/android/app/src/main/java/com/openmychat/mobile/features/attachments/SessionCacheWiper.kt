package com.openmychat.mobile.features.attachments

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * What a session saw stays with it: when the session ends (logout, 401, revoked token) the
 * downloaded attachments under [root] and the image loader's caches (thumbnails, avatars — memory
 * and disk) are wiped, like the message history cache.
 */
class SessionCacheWiper(
    private val root: File,
    private val clearImages: () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO
) {
    fun watch(scope: CoroutineScope, token: Flow<String?>): Job = scope.launch {
        token.collect { if (it == null) wipe() }
    }

    // Each step is guarded on its own: a busy disk cache or a locked file must neither crash sign-out
    // nor end the collector, so the next sign-out wipes again.
    private suspend fun wipe() = withContext(io) {
        runCatching { root.deleteRecursively() }
        runCatching { clearImages() }
    }
}
