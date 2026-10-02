package com.openmychat.mobile.features.call

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.VolumeDown
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.openmychat.mobile.R
import com.openmychat.mobile.core.util.DateTimeUtils
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.theme.CentyChatTheme
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.delay

/** The call screen is dark in both themes, like the desktop call panel. */
@Composable
fun CallScreen(
    viewModel: CallViewModel,
    onCallFinished: () -> Unit
) {
    CentyChatTheme(darkTheme = true) {
        LightSystemBarIcons()
        CallContent(viewModel, onCallFinished)
    }
}

/** Light status/navigation bar icons over the dark call screen; restored when it closes. */
@Composable
private fun LightSystemBarIcons() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.context as? Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        val status = controller?.isAppearanceLightStatusBars
        val navigation = controller?.isAppearanceLightNavigationBars
        controller?.isAppearanceLightStatusBars = false
        controller?.isAppearanceLightNavigationBars = false
        onDispose {
            if (status != null) controller.isAppearanceLightStatusBars = status
            if (navigation != null) controller.isAppearanceLightNavigationBars = navigation
        }
    }
}

@Composable
private fun CallContent(viewModel: CallViewModel, onCallFinished: () -> Unit) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val tokens = CentyTheme.tokens

    var hasAudioPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    var permissionDenied by remember { mutableStateOf(false) }
    val audioPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
        hasAudioPermission = isGranted
        permissionDenied = !isGranted
        if (!isGranted) {
            viewModel.rejectCall("Доступ к микрофону отклонен")
        } else if (uiState is CallUiState.Incoming) {
            viewModel.acceptCall()
        }
    }
    LaunchedEffect(Unit) {
        if (!hasAudioPermission) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    val isEnded = uiState is CallUiState.Ended
    // Back while ringing declines, during a call hangs up; the screen closes once the call ended.
    BackHandler(enabled = !isEnded) { viewModel.leave() }
    LaunchedEffect(isEnded, permissionDenied) {
        if (isEnded && !permissionDenied) {
            delay(1500)
            onCallFinished()
        }
    }

    val ringing = uiState is CallUiState.Incoming || uiState is CallUiState.Outgoing
    Surface(color = tokens.frame, contentColor = tokens.textMain, modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(horizontal = 24.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(
                modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Spacer(Modifier.size(32.dp))
                BreathingAvatar(name = uiState.peerName, breathing = ringing)
                Spacer(Modifier.size(28.dp))
                Text(
                    uiState.peerName,
                    style = MaterialTheme.typography.headlineMedium,
                    color = tokens.textStrong,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() }
                )
                Spacer(Modifier.size(8.dp))
                val statusText = when (val state = uiState) {
                    is CallUiState.Outgoing -> stringResource(R.string.call_outgoing)
                    is CallUiState.Incoming -> stringResource(R.string.call_incoming)
                    is CallUiState.Active -> DateTimeUtils.formatDuration(state.durationSeconds)
                    is CallUiState.Ended -> state.reason.ifBlank { stringResource(R.string.call_ended) }
                }
                AnimatedContent(
                    targetState = statusText,
                    transitionSpec = { fadeIn(CentyMotion.base()) togetherWith fadeOut(CentyMotion.fast()) },
                    label = "call-status"
                ) { text ->
                    Text(
                        text,
                        style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
                        color = if (uiState is CallUiState.Active) tokens.accentText else tokens.textSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    )
                }
                if (!hasAudioPermission) {
                    Spacer(Modifier.size(20.dp))
                    PermissionNotice()
                }
            }

            when (val state = uiState) {
                is CallUiState.Incoming -> Row(
                    Modifier.fillMaxWidth().padding(bottom = 16.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    RoundAction(Icons.Rounded.CallEnd, stringResource(R.string.call_decline), tokens.dangerFill, Color.White) { viewModel.rejectCall() }
                    RoundAction(Icons.Rounded.Call, stringResource(R.string.call_accept), tokens.successFill, Color.White) {
                        if (!hasAudioPermission) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO) else viewModel.acceptCall()
                    }
                }
                is CallUiState.Active, is CallUiState.Outgoing -> Row(
                    Modifier.fillMaxWidth().padding(bottom = 16.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    ToggleAction(
                        icon = if (state.isMuted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                        label = stringResource(R.string.call_mute),
                        state = stringResource(if (state.isMuted) R.string.call_mic_off else R.string.call_mic_on),
                        active = state.isMuted,
                        onClick = viewModel::toggleMute
                    )
                    RoundAction(Icons.Rounded.CallEnd, stringResource(R.string.call_end), tokens.dangerFill, Color.White) { viewModel.hangUp() }
                    ToggleAction(
                        icon = if (state.isSpeakerOn) Icons.Rounded.VolumeUp else Icons.Rounded.VolumeDown,
                        label = stringResource(R.string.call_speaker),
                        state = stringResource(if (state.isSpeakerOn) R.string.call_speaker_on else R.string.call_speaker_off),
                        active = state.isSpeakerOn,
                        onClick = viewModel::toggleSpeaker
                    )
                }
                is CallUiState.Ended -> OutlinedButton(
                    onClick = onCallFinished,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 160.dp).padding(bottom = 16.dp)
                ) { Text(stringResource(R.string.action_close)) }
            }
        }
    }
}

/** Incoming/outgoing: a ring breathes around the avatar (1 → 1.08, 1.6 s). Still with reduce motion. */
@Composable
private fun BreathingAvatar(name: String, breathing: Boolean, size: Dp = 120.dp) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val animate = breathing && !reduce
    // The loop exists only while ringing; it stops once the call connects.
    val scale = if (animate) {
        rememberInfiniteTransition(label = "breath").animateFloat(
            initialValue = 1f,
            targetValue = 1.08f,
            animationSpec = infiniteRepeatable(tween(CentyMotion.BREATH, easing = CentyMotion.EaseOut), RepeatMode.Reverse),
            label = "ring-scale"
        ).value
    } else {
        1f
    }
    val ringAlpha by animateColorAsState(if (breathing) tokens.primaryLine else Color.Transparent, CentyMotion.slow(), label = "ring")
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(size + 40.dp)) {
        Box(
            Modifier
                .size(size + 24.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .border(2.dp, ringAlpha, CircleShape)
        )
        CentyAvatar(name = name, size = size, ringColor = tokens.frame)
    }
}

@Composable
private fun PermissionNotice() {
    val tokens = CentyTheme.tokens
    val context = LocalContext.current
    Column(
        Modifier
            .widthIn(max = 360.dp)
            .background(tokens.dangerSoft, RoundedCornerShape(12.dp))
            .border(1.dp, tokens.dangerLine, RoundedCornerShape(12.dp))
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(stringResource(R.string.call_mic_denied), style = MaterialTheme.typography.titleSmall, color = tokens.dangerText)
        Spacer(Modifier.size(4.dp))
        Text(
            stringResource(R.string.call_mic_denied_message),
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.size(12.dp))
        OutlinedButton(
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            },
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.heightIn(min = 48.dp)
        ) { Text(stringResource(R.string.call_open_settings)) }
    }
}

@Composable
private fun RoundAction(icon: ImageVector, label: String, container: Color, content: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = container,
            contentColor = content,
            modifier = Modifier.size(64.dp).semantics { role = Role.Button }
        ) {
            Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = label, modifier = Modifier.size(30.dp)) }
        }
        Spacer(Modifier.size(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = CentyTheme.tokens.textSecondary)
    }
}

@Composable
private fun ToggleAction(icon: ImageVector, label: String, state: String, active: Boolean, onClick: () -> Unit) {
    val tokens = CentyTheme.tokens
    val container by animateColorAsState(if (active) tokens.textStrong else tokens.elevated, CentyMotion.base(), label = "toggle-bg")
    val content by animateColorAsState(if (active) tokens.frame else tokens.textStrong, CentyMotion.base(), label = "toggle-fg")
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = container,
            contentColor = content,
            modifier = Modifier.size(64.dp).semantics { stateDescription = state }
        ) {
            Box(contentAlignment = Alignment.Center) { Icon(icon, contentDescription = label, modifier = Modifier.size(28.dp)) }
        }
        Spacer(Modifier.size(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = tokens.textSecondary)
    }
}
