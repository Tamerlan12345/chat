package com.openmychat.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.model.ChangePasswordRequest
import com.openmychat.mobile.features.auth.ChangePasswordDialog
import com.openmychat.mobile.ui.navigation.AuthenticatedRouteState
import com.openmychat.mobile.ui.navigation.CentyNavHost
import com.openmychat.mobile.ui.navigation.NavKey
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import com.openmychat.mobile.ui.navigation.rememberNavBackStack
import com.openmychat.mobile.ui.theme.CentyChatTheme
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val app: CentyChatApp get() = application as CentyChatApp

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        setContent {
            CentyChatTheme {
                val initialKey = when {
                    app.sessionManager.token != null && app.sessionManager.currentUser != null -> NavKey.Conversations
                    app.sessionManager.serverUrl.isNotBlank() -> NavKey.Login
                    else -> NavKey.ServerConnect
                }

                val backStack = rememberNavBackStack(initialKey = initialKey)
                val mustChangePassword by app.sessionManager.mustChangePasswordFlow.collectAsState()
                val coroutineScope = rememberCoroutineScope()
                var changePasswordLoading by remember { mutableStateOf(false) }
                var changePasswordError by remember { mutableStateOf<String?>(null) }

                // Runtime permission request for notifications on Android 13+ (API 33+)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val notificationPermissionLauncher = rememberLauncherForActivityResult(
                        contract = ActivityResultContracts.RequestPermission()
                    ) { /* isGranted */ }

                    LaunchedEffect(Unit) {
                        if (ContextCompat.checkSelfPermission(
                                this@MainActivity,
                                Manifest.permission.POST_NOTIFICATIONS
                            ) != PackageManager.PERMISSION_GRANTED
                        ) {
                            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    }
                }

                // Observe global WebSocket events (Wake, Calls, Server Disconnects)
                LaunchedEffect(Unit) {
                    combine(
                        app.sessionManager.tokenFlow,
                        app.sessionManager.currentUserFlow,
                        app.sessionManager.storageState
                    ) { token, user, storageState ->
                        AuthenticatedRouteState(token, user != null, storageState)
                    }.collectLatest { session ->
                        if (SessionRouteGuard.hasAuthenticatedSession(session)) {
                            app.webSocketClient.connect(lifecycleScope)
                        } else {
                            app.webSocketClient.disconnect()
                            SessionRouteGuard.destinationAfterSessionLoss(
                                currentDestination = backStack.currentKey,
                                session = session,
                                hasConfiguredServer = app.sessionManager.serverUrl.isNotBlank()
                            )?.let(backStack::clearAndSet)
                        }
                    }
                }

                LaunchedEffect(Unit) {
                    app.webSocketClient.events.collect { event ->
                        when (event) {
                            is WsEvent.WakeRing -> {
                                triggerWakeVibration()
                                Toast.makeText(
                                    this@MainActivity,
                                    "Вас вызывает: ${event.fromName}",
                                    Toast.LENGTH_LONG
                                ).show()
                            }
                            is WsEvent.CallOffer -> {
                                val session = AuthenticatedRouteState(
                                    token = app.sessionManager.token,
                                    hasCurrentUser = app.sessionManager.currentUser != null,
                                    storageState = app.sessionManager.storageState.value
                                )
                                if (SessionRouteGuard.acceptsIncomingCall(session)) {
                                    backStack.navigate(
                                        NavKey.Call(
                                            peerId = event.senderId,
                                            peerName = event.senderName,
                                            isIncoming = true
                                        )
                                    )
                                }
                            }
                            is WsEvent.ServerDisconnect -> {
                                Toast.makeText(
                                    this@MainActivity,
                                    event.reason,
                                    Toast.LENGTH_LONG
                                ).show()
                                backStack.clearAndSet(NavKey.Login)
                            }
                            else -> Unit
                        }
                    }
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    CentyNavHost(
                        backStack = backStack,
                        apiClient = app.apiClient,
                        webSocketClient = app.webSocketClient,
                        sessionManager = app.sessionManager,
                        audioEngine = app.audioEngine
                    )

                    // Global mandatory blocking password change dialog
                    if (mustChangePassword && app.sessionManager.token != null) {
                        ChangePasswordDialog(
                            isLoading = changePasswordLoading,
                            errorMessage = changePasswordError,
                            onDismiss = null, // Undismissable until successfully changed
                            onSubmit = { oldPass, newPass ->
                                coroutineScope.launch {
                                    changePasswordLoading = true
                                    changePasswordError = null
                                    try {
                                        val resp = app.apiClient.changePassword(
                                            ChangePasswordRequest(oldPassword = oldPass, newPassword = newPass)
                                        )
                                        if (resp.success) {
                                            app.sessionManager.mustChangePassword = false
                                        } else {
                                            changePasswordError = resp.message.ifBlank { "Ошибка смены пароля" }
                                        }
                                    } catch (e: Exception) {
                                        changePasswordError = e.message ?: "Ошибка смены пароля"
                                    } finally {
                                        changePasswordLoading = false
                                    }
                                }
                            }
                        )
                    }
                }
            }
        }
    }

    private fun triggerWakeVibration() {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }

            if (vibrator?.hasVibrator() == true) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val timings = longArrayOf(0, 250, 150, 250, 150, 400)
                    val amplitudes = intArrayOf(0, 255, 0, 255, 0, 255)
                    val effect = VibrationEffect.createWaveform(timings, amplitudes, -1)
                    vibrator.vibrate(effect)
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(longArrayOf(0, 250, 150, 250, 150, 400), -1)
                }
            }
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        app.webSocketClient.disconnect()
        app.audioEngine.stop()
    }
}
