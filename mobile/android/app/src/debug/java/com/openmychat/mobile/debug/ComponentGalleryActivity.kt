package com.openmychat.mobile.debug

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.ConversationType
import com.openmychat.mobile.data.model.DeliveryStatus
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageMetadata
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.features.chat.ChatActions
import com.openmychat.mobile.features.chat.ChatContent
import com.openmychat.mobile.features.chat.ChatUiState
import com.openmychat.mobile.ui.components.AcknowledgeButton
import com.openmychat.mobile.ui.components.BreathingRing
import com.openmychat.mobile.ui.components.CallControl
import com.openmychat.mobile.ui.components.CallToggle
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyOutlinedButton
import com.openmychat.mobile.ui.components.ConnectionBanner
import com.openmychat.mobile.ui.components.DeliveryMark
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.ErrorState
import com.openmychat.mobile.ui.components.FileAttachmentTile
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.ImageAttachmentTile
import com.openmychat.mobile.ui.components.LevelMeter
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.theme.CentyChatTheme
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.sin

/**
 * DEBUG ONLY. A harness for the UI layer v2 components whose data does not exist yet: the send
 * queue's queued / sending / failed states with «Повторить», uploads, empty states, the banner
 * cycle, the «Ознакомлен» stamp and the call meter. Everything here is local and fake on purpose;
 * the real screens wire the same components to real data.
 */
class ComponentGalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { CentyChatTheme { Gallery() } }
    }
}

private val Tabs = listOf("Отправка", "Пустые", "Связь", "Ознакомлен", "Звонок", "Вложения")

@Composable
private fun Gallery() {
    var tab by remember { mutableIntStateOf(0) }
    val tokens = CentyTheme.tokens
    Column(Modifier.fillMaxSize().background(tokens.canvas)) {
        PrimaryScrollableTabRow(
            selectedTabIndex = tab,
            containerColor = tokens.list,
            contentColor = tokens.accentText,
            edgePadding = 8.dp,
            modifier = Modifier.statusBarsPadding()
        ) {
            Tabs.forEachIndexed { i, title -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) }) }
        }
        Box(Modifier.weight(1f)) {
            when (tab) {
                0 -> SendQueueHarness()
                1 -> EmptyStates()
                2 -> BannerCycle()
                3 -> Stamp()
                4 -> CallMeter()
                else -> Attachments()
            }
        }
    }
}

/**
 * The real ChatContent with a fake send queue: the first send fails (red ⟲, one shake, warning
 * haptic, «Повторить / Удалить»), a retry goes sending → sent → delivered → read.
 */
@Composable
private fun SendQueueHarness() {
    val scope = rememberCoroutineScope()
    val me = 1L
    val peer = 2L
    val start = remember { Instant.now().minus(20, ChronoUnit.MINUTES) }
    fun at(minutes: Long) = start.plus(minutes, ChronoUnit.MINUTES).toString()
    val messages = remember {
        mutableStateListOf(
            Message(1, ConversationType.DIRECT, me, peer, "Привет! Пришлёшь отчёт к обеду?", createdAt = at(0), senderName = "Боб Тестов"),
            Message(2, ConversationType.DIRECT, me, peer, "Нужна версия с правками.", createdAt = at(1), senderName = "Боб Тестов"),
            Message(3, ConversationType.DIRECT, peer, me, "Да, почти готов", createdAt = at(2), deliveryStatus = DeliveryStatus.READ),
            Message(
                4, ConversationType.DIRECT, me, peer, "Спасибо!", createdAt = at(3), senderName = "Боб Тестов",
                metadata = MessageMetadata(replyText = "Да, почти готов", replySenderName = "Вы")
            )
        )
    }
    val marks = remember { mutableStateMapOf<Long, DeliveryMark>() }
    var failNext by remember { mutableStateOf(true) }
    var nextId by remember { mutableIntStateOf(100) }

    fun deliver(id: Long) {
        scope.launch {
            marks[id] = DeliveryMark.SENDING
            delay(700)
            if (failNext) {
                failNext = false
                marks[id] = DeliveryMark.FAILED
                return@launch
            }
            marks.remove(id)
            delay(900)
            val i = messages.indexOfFirst { it.id == id }
            if (i >= 0) messages[i] = messages[i].copy(deliveryStatus = DeliveryStatus.DELIVERED)
            delay(900)
            val j = messages.indexOfFirst { it.id == id }
            if (j >= 0) messages[j] = messages[j].copy(deliveryStatus = DeliveryStatus.READ)
        }
    }

    val actions = remember {
        object : ChatActions {
            override fun canEdit(message: Message) = message.senderId == me
            override fun canDelete(message: Message) = message.senderId == me
            override fun localMark(message: Message): DeliveryMark? = marks[message.id]
            override fun onSend(text: String, replyTo: Message?) {
                val id = (nextId++).toLong()
                messages += Message(
                    id, ConversationType.DIRECT, peer, me, text, createdAt = Instant.now().toString(),
                    metadata = replyTo?.let { MessageMetadata(replyText = it.text, replySenderName = it.senderName) }
                )
                marks[id] = DeliveryMark.QUEUED
                deliver(id)
            }
            override fun onRetrySend(message: Message) = deliver(message.id)
            override fun onDiscardFailed(message: Message) {
                marks.remove(message.id)
                messages.removeAll { it.id == message.id }
            }
            override fun onDelete(message: Message) {
                messages.removeAll { it.id == message.id }
            }
        }
    }
    ChatContent(
        title = "Боб Тестов",
        isDirect = true,
        uiState = ChatUiState.Content(messages.toList()),
        currentUserId = me,
        connectionState = ConnectionState.Connected,
        actions = actions,
        peerStatus = UserStatus.ONLINE,
        showBackButton = false
    )
}

@Composable
private fun EmptyStates() {
    val kinds = listOf(
        Triple(Illustration.INBOX, "Пока нет диалогов", "Когда вы или коллега напишете первое сообщение, диалог появится здесь."),
        Triple(Illustration.CHANNELS, "Пока нет каналов", "Каналы, в которых вы состоите, появятся здесь."),
        Triple(Illustration.ANNOUNCEMENTS, "Объявлений нет", "Новые объявления компании появятся здесь."),
        Triple(Illustration.SEARCH, "Никого не нашли", "Проверьте, как написано имя."),
        Triple(Illustration.OFFLINE, "Не удалось загрузить чаты", "Проверьте подключение к интернету и повторите попытку.")
    )
    var shown by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize().background(CentyTheme.tokens.list)) {
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Чаты", "Каналы", "Объявления", "Поиск", "Сеть").forEachIndexed { i, label ->
                FilterChip(selected = shown == i, onClick = { shown = i }, label = { Text(label) })
            }
        }
        AnimatedContent(shown, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "empty") { i ->
            val (kind, title, message) = kinds[i]
            if (kind == Illustration.OFFLINE) {
                ErrorState(title = title, onRetry = {}, message = message)
            } else {
                EmptyState(illustration = kind, title = title, message = message, actionLabel = if (i == 0) "Обновить" else null, onAction = {})
            }
        }
    }
}

@Composable
private fun BannerCycle() {
    var state by remember { mutableStateOf<ConnectionState>(ConnectionState.Connected) }
    var network by remember { mutableStateOf(true) }
    Column(Modifier.fillMaxSize().background(CentyTheme.tokens.list)) {
        ConnectionBanner(state, graceMillis = 0, networkAvailable = network)
        Spacer(Modifier.height(24.dp))
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CentyOutlinedButton(onClick = { network = false; state = ConnectionState.Disconnected }) { Text("Нет сети") }
            CentyOutlinedButton(onClick = { network = true; state = ConnectionState.Connecting }) { Text("Переподкл.") }
            CentyOutlinedButton(onClick = { network = true; state = ConnectionState.Connected }) { Text("В сети") }
        }
    }
}

@Composable
private fun Stamp() {
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    val tokens = CentyTheme.tokens
    Column(Modifier.fillMaxSize().background(tokens.elevated).padding(24.dp), verticalArrangement = Arrangement.Bottom) {
        Text("Плановые работы в субботу", style = MaterialTheme.typography.headlineSmall, color = tokens.textStrong)
        Spacer(Modifier.height(8.dp))
        Text("Серверы будут недоступны с 10:00 до 12:00. Сохраните документы заранее.", style = MaterialTheme.typography.bodyLarge, color = tokens.textMain)
        Spacer(Modifier.height(24.dp))
        AcknowledgeButton(acknowledged = done, busy = busy, onAcknowledge = {
            scope.launch {
                busy = true
                delay(600)
                busy = false
                done = true
                haptics.confirm()
            }
        })
        Spacer(Modifier.height(12.dp))
        CentyOutlinedButton(onClick = { done = false }, modifier = Modifier.fillMaxWidth()) { Text("Сначала") }
    }
}

@Composable
private fun CallMeter() {
    var level by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) {
        var t = 0f
        while (true) {
            delay(40)
            t += 0.04f
            // Speech-like bursts: syllables over a slow phrase envelope.
            val phrase = (sin(t * 0.9f) + 1f) / 2f
            val syllable = abs(sin(t * 7.3f))
            level = (phrase * syllable * 0.45f).coerceIn(0f, 1f)
        }
    }
    CentyChatTheme(darkTheme = true) {
        val tokens = CentyTheme.tokens
        Column(
            Modifier.fillMaxSize().background(tokens.frame).safeDrawingPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.height(32.dp))
                BreathingRing(breathing = false) { CentyAvatar("Боб Тестов", size = 120.dp, ringColor = tokens.frame) }
                Spacer(Modifier.height(16.dp))
                Text("Боб Тестов", style = MaterialTheme.typography.headlineMedium, color = tokens.textStrong)
                Spacer(Modifier.height(10.dp))
                LevelMeter(level = { level })
                Spacer(Modifier.height(10.dp))
                Text("01:24", style = MaterialTheme.typography.titleMedium, color = tokens.accentText)
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                CallToggle(Icons.Rounded.Mic, "Микрофон", "Включён", active = false, onClick = {})
                CallControl(Icons.Rounded.CallEnd, "Завершить", tokens.dangerFill, Color.White) {}
                CallToggle(Icons.Rounded.VolumeUp, "Динамик", "Выключен", active = false, onClick = {})
            }
        }
    }
}

@Composable
private fun Attachments() {
    var progress by remember { mutableFloatStateOf(0f) }
    var run by remember { mutableIntStateOf(0) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(run) {
        loaded = false
        progress = 0f
        while (progress < 1f) {
            delay(60)
            progress = (progress + 0.03f).coerceAtMost(1f)
        }
        loaded = true
    }
    Column(Modifier.fillMaxSize().background(CentyTheme.tokens.canvas).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.widthIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            FileAttachmentTile("Регламент 2026.pdf", "1,2 МБ", onOpen = {})
            FileAttachmentTile("Смета.xlsx", "312 КБ", progress = if (progress < 1f) progress else null)
            FileAttachmentTile("Отчёт.docx", "86 КБ", failed = true, onRetry = { run++ })
            ImageAttachmentTile(
                aspectRatio = 4f / 3f,
                placeholder = Color(0xFF7D8DA3),
                loaded = loaded,
                progress = if (progress < 1f) progress else null,
                image = { Box(Modifier.fillMaxSize().background(Color(0xFF52627A))) }
            )
        }
        CentyOutlinedButton(onClick = { run++ }) { Text("Ещё раз") }
    }
}
