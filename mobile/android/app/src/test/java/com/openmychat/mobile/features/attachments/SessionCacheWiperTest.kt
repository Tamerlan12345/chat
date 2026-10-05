package com.openmychat.mobile.features.attachments

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Downloaded files and cached thumbnails/avatars of a session do not outlive it. */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionCacheWiperTest {

    @get:Rule val tmp = TemporaryFolder()

    private val dispatcher = UnconfinedTestDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private var imageWipes = 0

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun signingOutWipesTheFilesAndTheImageCaches() {
        val root = File(tmp.root, "attachments").apply { mkdirs() }
        File(root, "42").mkdirs()
        File(root, "42/отчёт.pdf").writeText("secret")
        val token = MutableStateFlow<String?>("token")

        SessionCacheWiper(root, clearImages = { imageWipes++ }, io = dispatcher).watch(scope, token)

        assertTrue("nothing is wiped while signed in", File(root, "42/отчёт.pdf").exists())
        assertEquals(0, imageWipes)

        token.value = null

        assertFalse(root.exists())
        assertEquals(1, imageWipes)

        token.value = "next"
        token.value = null
        assertEquals("every sign-out wipes", 2, imageWipes)
    }
}
