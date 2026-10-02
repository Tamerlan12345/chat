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
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.openmychat.mobile.core.audio.CallAudio
import com.openmychat.mobile.core.network.WsEvent
import com.openmychat.mobile.data.realtime.RealtimeConnectionManager
import com.openmychat.mobile.features.auth.ChangePasswordDialog
import com.openmychat.mobile.ui.navigation.CentyNavHost
import com.openmychat.mobile.ui.navigation.NavKey
import com.openmychat.mobile.ui.navigation.SessionRouteGuard
import com.openmychat.mobile.ui.navigation.rememberNavBackStack
import com.openmychat.mobile.ui.theme.CentyChatTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var connectionManager: RealtimeConnectionManager
    @Inject lateinit var callAudio: CallAudio

    private val appViewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        connectionManager.start()

        setContent {
            CentyChatTheme {
                val initialKey = when {
                    SessionRouteGuard.hasAuthenticatedSession(appViewModel.routeState()) -> NavKey.Conversations
                    appViewModel.hasConfiguredServer -> NavKey.Login
                    else -> NavKey.ServerConnect
                }

                val backStack = rememberNavBackStack(initialKey = initialKey)
                val passwordChange by appViewModel.passwordChange.collectAsState()

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

                // Session loss returns protected destinations to sign-in.
                LaunchedEffect(Unit) {
                    appViewModel.routeStates.collect { session ->
                        SessionRouteGuard.destinationAfterSessionLoss(
                            currentDestination = backStack.currentKey,
                            session = session,
                            hasConfiguredServer = appViewModel.hasConfiguredServer
                        )?.let(backStack::clearAndSet)
                    }
                }

                LaunchedEffect(Unit) {
                    appViewModel.globalEvents.collect { event ->
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
                                if (appViewModel.acceptsIncomingCall()) {
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
                        routeStates = appViewModel.routeStates,
                        currentRouteState = appViewModel::routeState,
                        hasConfiguredServer = { appViewModel.hasConfiguredServer }
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
