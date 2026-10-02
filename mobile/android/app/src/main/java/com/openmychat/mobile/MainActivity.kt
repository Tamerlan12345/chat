package com.openmychat.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.openmychat.mobile.core.audio.CallAudio
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.realtime.RealtimeConnectionManager
import com.openmychat.mobile.features.auth.ChangePasswordDialog
import com.openmychat.mobile.ui.navigation.AppNavigationState
import com.openmychat.mobile.ui.navigation.AppNavigator
import com.openmychat.mobile.ui.navigation.CentyNavigation
import com.openmychat.mobile.ui.navigation.NavKey
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import com.openmychat.mobile.ui.navigation.rememberAppNavigationState
import com.openmychat.mobile.ui.components.LocalSnackbarAnchor
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.SnackbarAnchor
import com.openmychat.mobile.ui.theme.CentyChatTheme
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.launch
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var connectionManager: RealtimeConnectionManager
    @Inject lateinit var callAudio: CallAudio

    private val appViewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        connectionManager.start()

        setContent {
            CentyChatTheme {
                val navigationState = rememberAppNavigationState {
                    if (SessionRouteGuard.hasAuthenticatedSession(appViewModel.routeState())) {
                        AppNavigationState.authenticated()
                    } else {
                        AppNavigationState.signedOut()
                    }
                }
                // A restored stack is re-checked against the session before it is ever rendered.
                val navigator = remember(navigationState) {
                    AppNavigator(navigationState).also {
                        it.syncWithSession(appViewModel.routeState())
                    }
                }
                val session by appViewModel.routeStates.collectAsState(initial = appViewModel.routeState())
                val passwordChange by appViewModel.passwordChange.collectAsState()
                // Transient feedback is a Material snackbar, never a Toast.
                val snackbarHostState = remember { SnackbarHostState() }

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

                // Session loss (logout elsewhere, revoked token, unavailable storage) clears all stacks.
                LaunchedEffect(navigator) {
                    appViewModel.routeStates.collect {
                        // Re-read the live session: combined emissions can be intermediate states.
                        val current = appViewModel.routeState()
                        if (!SessionRouteGuard.hasAuthenticatedSession(current) && !navigator.state.isAuthFlow) {
                            navigator.onLoggedOut()
                        }
                    }
                }

                LaunchedEffect(Unit) {
                    appViewModel.globalEvents.collect { event ->
                        when (event) {
                            is WsEvent.WakeRing -> {
                                triggerWakeVibration()
                                val text = event.fromName.takeIf { it.isNotBlank() }
                                    ?.let { getString(R.string.wake_received, it) }
                                    ?: getString(R.string.wake_received_unknown)
                                launch { snackbarHostState.showSnackbar(text, duration = SnackbarDuration.Long) }
                            }
                            is WsEvent.CallOffer -> {
                                if (appViewModel.acceptsIncomingCall()) {
                                    val call = NavKey.Call(
                                        peerId = event.senderId,
                                        peerName = event.senderName,
                                        isIncoming = true
                                    )
                                    if (!navigator.showIncomingCall(call)) {
                                        appViewModel.rejectBusy(event.senderId)
                                    }
                                }
                            }
                            is WsEvent.ServerDisconnect -> {
                                // The socket reconnects; a revoked token comes back as auth_error and
                                // is verified over HTTP, which signs out on 401. A still-valid session
                                // (e.g. a role change) simply continues.
                                if (event.reason.isNotBlank()) {
                                    launch { snackbarHostState.showSnackbar(event.reason, duration = SnackbarDuration.Long) }
                                }
                            }
                            else -> Unit
                        }
                    }
                }

                val snackbarAnchor = remember { SnackbarAnchor() }
                CompositionLocalProvider(
                    LocalSnackbarHostState provides snackbarHostState,
                    LocalSnackbarAnchor provides snackbarAnchor
                ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = CentyTheme.tokens.canvas
                ) {
                    CentyNavigation(
                        navigator = navigator,
                        session = session,
                        currentSession = appViewModel::routeState
                    )

                    // Global mandatory blocking password change dialog
                    val dialog = passwordChange
                    if (dialog is PasswordChangeUiState.Visible) {
                        ChangePasswordDialog(
                            isLoading = dialog.isLoading,
                            errorMessage = dialog.error,
                            onDismiss = null, // Undismissable until successfully changed
                            onSubmit = appViewModel::changePassword
                        )
                    }
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
                val timings = longArrayOf(0, 250, 150, 250, 150, 400)
                val amplitudes = intArrayOf(0, 255, 0, 255, 0, 255)
                vibrator.vibrate(VibrationEffect.createWaveform(timings, amplitudes, -1))
            }
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        // Recreation (theme, locale) keeps the socket; leaving the app tears it down.
        if (isFinishing) {
            connectionManager.stop()
            callAudio.stop()
        }
    }
}
