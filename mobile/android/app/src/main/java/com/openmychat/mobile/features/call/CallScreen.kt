package com.openmychat.mobile.features.call

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.ui.components.CentyAvatar
import kotlinx.coroutines.delay

@Composable
fun CallScreen(
    viewModel: CallViewModel,
    onCallFinished: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    var hasAudioPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        )
    }

    val audioPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        hasAudioPermission = isGranted
        if (!isGranted) {
            viewModel.rejectCall("Доступ к микрофону отклонен")
        } else if (uiState is CallUiState.Incoming) {
            viewModel.acceptCall()
        }
    }

    LaunchedEffect(Unit) {
        if (!hasAudioPermission) {
            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    val isEnded = uiState is CallUiState.Ended
    LaunchedEffect(isEnded) {
        if (isEnded) {
            delay(1500)
            onCallFinished()
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.surface
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top Section: Peer Info & Status
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(top = 48.dp)
            ) {
                CentyAvatar(
                    name = uiState.peerName,
                    size = 110.dp
                )

                Spacer(modifier = Modifier.height(24.dp))

                Text(
                    text = uiState.peerName,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold
                )

                Spacer(modifier = Modifier.height(8.dp))

                val statusText = when (val state = uiState) {
                    is CallUiState.Outgoing -> "Исходящий вызов…"
                    is CallUiState.Incoming -> "Входящий вызов…"
                    is CallUiState.Active -> DateTimeUtils.formatDuration(state.durationSeconds)
                    is CallUiState.Ended -> state.reason
                }

                Text(
                    text = statusText,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (uiState is CallUiState.Active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                )

                if (!hasAudioPermission) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text(
                            text = "Требуется разрешение на микрофон",
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                        )
                    }
                }
            }

            // Bottom Section: Call Action Buttons
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(bottom = 32.dp)
            ) {
                when (uiState) {
                    is CallUiState.Incoming -> {
                        // Incoming call: Accept & Reject
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            // Reject Button
                            IconButton(
                                onClick = { viewModel.rejectCall() },
                                modifier = Modifier
                                    .size(64.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.error)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.CallEnd,
                                    contentDescription = "Отклонить",
                                    tint = MaterialTheme.colorScheme.onError,
                                    modifier = Modifier.size(32.dp)
                                )
                            }

                            // Accept Button
                            IconButton(
                                onClick = {
                                    if (!hasAudioPermission) {
                                        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    } else {
                                        viewModel.acceptCall()
                                    }
                                },
                                modifier = Modifier
                                    .size(64.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFF2E7D32))
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Call,
                                    contentDescription = "Ответить",
                                    tint = Color.White,
                                    modifier = Modifier.size(32.dp)
                                )
                            }
                        }
                    }
                    is CallUiState.Active, is CallUiState.Outgoing -> {
                        // In-Call Controls
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            // Mute Toggle
                            IconButton(
                                onClick = { viewModel.toggleMute() },
                                modifier = Modifier
                                    .size(56.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (uiState.isMuted) MaterialTheme.colorScheme.primaryContainer
                                        else MaterialTheme.colorScheme.surfaceVariant
                                    )
                            ) {
                                Icon(
                                    imageVector = if (uiState.isMuted) Icons.Default.MicOff else Icons.Default.Mic,
                                    contentDescription = "Микрофон",
                                    tint = if (uiState.isMuted) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }

                            // Hang Up Button
                            IconButton(
                                onClick = { viewModel.hangUp() },
                                modifier = Modifier
                                    .size(64.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.error)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.CallEnd,
                                    contentDescription = "Завершить",
                                    tint = MaterialTheme.colorScheme.onError,
                                    modifier = Modifier.size(32.dp)
                                )
                            }

                            // Speakerphone Toggle
                            IconButton(
                                onClick = { viewModel.toggleSpeaker() },
                                modifier = Modifier
                                    .size(56.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (uiState.isSpeakerOn) MaterialTheme.colorScheme.primaryContainer
                                        else MaterialTheme.colorScheme.surfaceVariant
                                    )
                            ) {
                                Icon(
                                    imageVector = if (uiState.isSpeakerOn) Icons.Default.VolumeUp else Icons.Default.VolumeDown,
                                    contentDescription = "Динамик",
                                    tint = if (uiState.isSpeakerOn) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                    is CallUiState.Ended -> {
                        // Ended / Failed state
                        Button(
                            onClick = onCallFinished,
                            modifier = Modifier.height(48.dp)
                        ) {
                            Text("Закрыть")
                        }
                    }
                }
            }
        }
    }
}
