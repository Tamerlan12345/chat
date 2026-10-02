package com.openmychat.mobile.features.people

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.components.LocalSnackbarHostState
import com.openmychat.mobile.ui.components.SharedKeys
import com.openmychat.mobile.ui.components.StatusDot
import com.openmychat.mobile.ui.components.presenceLabel
import com.openmychat.mobile.ui.components.rememberHaptics
import com.openmychat.mobile.ui.components.sharedConversationElement
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import kotlinx.coroutines.launch

/** Действия карточки; по умолчанию — ничего (превью и тесты). */
interface PersonCardActions {
    fun onBack() {}
    fun onWrite(person: Person) {}
    fun onCall(person: Person) {}
    fun onWake() {}
    fun onOpenDepartment(person: Person) {}
    fun onEditProfile() {}
}

@Composable
fun PersonCardScreen(
    viewModel: PersonViewModel,
    /** Имя и фото из строки, откуда открыли: заголовок есть сразу, ещё до справочника. */
    placeholderName: String,
    placeholderAvatar: String?,
    placeholderStatus: String?,
    showBackButton: Boolean,
    actions: PersonCardActions
) {
    val state by viewModel.state.collectAsState()
    val haptics = rememberHaptics()
    val wrapped = remember(viewModel, actions) {
        object : PersonCardActions by actions {
            override fun onWake() {
                viewModel.wake()
                haptics.confirm()
                actions.onWake()
            }
        }
    }
    PersonCardContent(
        state = state,
        placeholder = Person(
            id = viewModel.userId,
            fullName = placeholderName,
            avatarUrl = placeholderAvatar,
            status = UserStatus.fromValue(placeholderStatus)
        ),
        showBackButton = showBackButton,
        actions = wrapped
    )
}

/**
 * Карточка сотрудника: шапка по центру (аватар 96, имя, статус, «был(а) в сети», свой статус в
 * кавычках), ряд действий «Написать · Позвонить · Побудить» и группа сведений. Пустые поля не
 * показываются. Своя карточка: вместо действий — «Редактировать профиль».
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun PersonCardContent(
    state: PersonCardState,
    placeholder: Person,
    actions: PersonCardActions,
    modifier: Modifier = Modifier,
    showBackButton: Boolean = true
) {
    val tokens = CentyTheme.tokens
    val person = state.person ?: placeholder
    val shared = personSharedKey(person.id)
    Scaffold(
        modifier = modifier.testTag("person-card"),
        containerColor = tokens.list,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    if (showBackButton) {
                        IconButton(onClick = actions::onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    navigationIconContentColor = tokens.textSecondary
                )
            )
        }
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                CentyAvatar(
                    name = person.fullName,
                    avatarUrl = person.avatarUrl,
                    status = person.status,
                    size = 96.dp,
                    ringColor = tokens.list,
                    modifier = Modifier.sharedConversationElement(SharedKeys.avatar(shared))
                )
                Spacer(Modifier.height(12.dp))
                // Имя никогда не красное (в отличие от панели десктопа): на телефоне это читалось бы как ошибка.
                Text(
                    person.fullName,
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = tokens.textStrong,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .sharedConversationElement(SharedKeys.title(shared))
                        .semantics { heading() }
                )
                Spacer(Modifier.height(4.dp))
                StatusLine(person)
                person.customStatus?.let {
                    Text(
                        stringResource(R.string.person_custom_status, it),
                        style = MaterialTheme.typography.bodyMedium,
                        color = tokens.textSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 2.dp)
                    )
                }
                Spacer(Modifier.height(20.dp))
                if (state.isSelf) {
                    CentyPrimaryButton(
                        text = stringResource(R.string.person_edit_profile),
                        onClick = actions::onEditProfile,
                        modifier = Modifier.fillMaxWidth().testTag("person-edit-profile")
                    )
                } else {
                    ActionRow(person, state, actions)
                }
                Spacer(Modifier.height(20.dp))
                InfoGroup(person, actions)
            }
        }
    }
}

@Composable
private fun StatusLine(person: Person) {
    val tokens = CentyTheme.tokens
    val line = remember(person.status, person.lastSeen) { PresenceLine.of(person.status, person.lastSeen) }
    val text = when (line) {
        PresenceLine.Online -> presenceLabel(UserStatus.ONLINE)
        PresenceLine.Away -> stringResource(R.string.person_status_away)
        PresenceLine.DoNotDisturb -> presenceLabel(UserStatus.DND)
        PresenceLine.Offline -> presenceLabel(UserStatus.OFFLINE)
        is PresenceLine.SeenToday -> stringResource(R.string.person_seen_today, line.time)
        is PresenceLine.SeenYesterday -> stringResource(R.string.person_seen_yesterday, line.time)
        is PresenceLine.SeenOn -> stringResource(R.string.person_seen_on, line.date)
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("person-status")) {
        StatusDot(person.status, size = 8.dp)
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = tokens.textSecondary)
    }
}

/** «Написать» (основная), «Позвонить» и «Побудить» (тональные), 72 dp, значок над подписью. */
@Composable
private fun ActionRow(person: Person, state: PersonCardState, actions: PersonCardActions) {
    val tokens = CentyTheme.tokens
    val haptics = rememberHaptics()
    val active = !state.inactive
    val labels = listOf(
        stringResource(R.string.person_write),
        stringResource(R.string.person_call),
        if (state.wakeCooldown > 0) stringResource(R.string.person_wake_wait, state.wakeCooldown) else stringResource(R.string.person_wake)
    )
    BoxWithConstraints(Modifier.fillMaxWidth()) {
    // Одна величина подписи на весь ряд: самая крупная, при которой все три влезают в плитку.
    val labelStyle = rowLabelStyle(labels, tileWidth = (maxWidth - 16.dp) / 3 - 8.dp)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ActionTile(
            icon = Icons.AutoMirrored.Outlined.Chat,
            label = labels[0],
            labelStyle = labelStyle,
            primary = true,
            enabled = active,
            onClick = { haptics.tick(); actions.onWrite(person) },
            modifier = Modifier.weight(1f).testTag("person-write")
        )
        ActionTile(
            icon = Icons.Outlined.Call,
            label = labels[1],
            labelStyle = labelStyle,
            primary = false,
            enabled = active && state.call == CallAvailability.AVAILABLE,
            onClick = { haptics.tick(); actions.onCall(person) },
            modifier = Modifier.weight(1f).testTag("person-call")
        )
        ActionTile(
            icon = Icons.Outlined.NotificationsActive,
            label = labels[2],
            labelStyle = labelStyle,
            primary = false,
            enabled = active && state.wakeCooldown == 0,
            onClick = actions::onWake,
            modifier = Modifier.weight(1f).testTag("person-wake")
        )
    }
    }
    // Почему звонок недоступен — подписью под рядом, а не всплывающим сообщением.
    val reason = when {
        state.inactive -> R.string.person_inactive
        state.call == CallAvailability.NOT_PERMITTED -> R.string.person_call_not_permitted
        state.call == CallAvailability.PEER_DND -> R.string.person_call_dnd
        state.call == CallAvailability.PEER_OFFLINE -> R.string.person_call_offline
        else -> null
    }
    AnimatedVisibility(visible = reason != null) {
        Text(
            stringResource(reason ?: R.string.person_call_offline),
            style = MaterialTheme.typography.bodySmall,
            color = tokens.textDim,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("person-call-reason")
        )
    }
}

@Composable
private fun ActionTile(
    icon: ImageVector,
    label: String,
    labelStyle: TextStyle,
    primary: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    val reduce = LocalReduceMotion.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed && !reduce) 0.97f else 1f, CentyMotion.fast(), label = "tile-press")
    val fill = when {
        primary && pressed -> tokens.primaryPressed
        primary -> tokens.primary
        pressed -> tokens.primaryLine
        else -> tokens.primarySoft
    }
    val content = if (primary) Color.White else tokens.accentText
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier = modifier
            .heightIn(min = 72.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(shape)
            .background(if (enabled) fill else fill.copy(alpha = fill.alpha * 0.38f))
            .combinedClickable(
                interactionSource = interaction,
                indication = ripple(),
                enabled = enabled,
                role = Role.Button,
                onClick = onClick
            )
            .padding(horizontal = 4.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        val color = if (enabled) content else tokens.textDim
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(24.dp))
        Spacer(Modifier.height(4.dp))
        // Одна строка; величина общая для ряда (rowLabelStyle) — слово не рвётся («Написат-ь»).
        Text(label, style = labelStyle, color = color, maxLines = 1, textAlign = TextAlign.Center, softWrap = false)
    }
}

/**
 * Сведения на L3-карточке: должность, отдел (тап — «Отделы» с этой веткой), вн. номер (тап —
 * копировать), мобильный (тап — набор, долгое нажатие — копировать), почта (тап — письмо,
 * долгое — копировать), роль. Пустых строк нет.
 */
@Composable
private fun InfoGroup(person: Person, actions: PersonCardActions) {
    val tokens = CentyTheme.tokens
    val context = LocalContext.current
    val snackbar = LocalSnackbarHostState.current
    val scope = rememberCoroutineScope()
    val copied = stringResource(R.string.person_copied)
    val noApp = stringResource(R.string.person_no_app)
    fun copy(value: String, sensitive: Boolean = false) {
        copyToClipboard(context, value, sensitive)
        scope.launch { snackbar.showSnackbar(copied) }
    }
    fun open(intent: Intent) {
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            scope.launch { snackbar.showSnackbar(noApp) }
        }
    }
    val rows = buildList {
        person.jobTitle?.let { add(InfoRowData(R.string.person_job, it)) }
        person.departmentName?.let {
            add(InfoRowData(R.string.person_department, it, trailing = Icons.Outlined.ChevronRight, hint = R.string.person_show_department, onTap = { actions.onOpenDepartment(person) }))
        }
        person.extension?.let { add(InfoRowData(R.string.person_extension, it, hint = R.string.person_copy_hint, onTap = { copy(it) })) }
        person.phone?.let { phone ->
            add(
                InfoRowData(
                    R.string.person_phone, phone, trailing = Icons.Outlined.Phone, hint = R.string.person_call_phone,
                    onTap = { ContactLinks.dial(phone)?.let { open(Intent(Intent.ACTION_DIAL, it)) } ?: copy(phone, sensitive = true) },
                    onLongPress = { copy(phone, sensitive = true) }
                )
            )
        }
        person.email?.let { email ->
            add(
                InfoRowData(
                    R.string.person_email, email, trailing = Icons.Outlined.Email, hint = R.string.person_write_email,
                    onTap = { ContactLinks.mail(email)?.let { open(Intent(Intent.ACTION_SENDTO, it)) } ?: copy(email, sensitive = true) },
                    onLongPress = { copy(email, sensitive = true) }
                )
            )
        }
        person.roleName?.let { add(InfoRowData(R.string.person_role, it)) }
    }
    if (rows.isEmpty()) return
    val shape = RoundedCornerShape(CentyRadius.card)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tokens.elevated)
            .border(1.dp, tokens.border, shape)
            .testTag("person-info")
    ) {
        rows.forEachIndexed { index, row ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = tokens.border)
            InfoRow(row)
        }
    }
}

private class InfoRowData(
    val label: Int,
    val value: String,
    val trailing: ImageVector? = null,
    val hint: Int? = null,
    val onTap: (() -> Unit)? = null,
    val onLongPress: (() -> Unit)? = null
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun InfoRow(row: InfoRowData) {
    val tokens = CentyTheme.tokens
    val hint = row.hint?.let { stringResource(it) }
    val copyHint = stringResource(R.string.person_copy_hint)
    val interactive = row.onTap != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .then(
                if (interactive) {
                    Modifier.combinedClickable(
                        role = Role.Button,
                        onClickLabel = hint,
                        onLongClickLabel = if (row.onLongPress != null) copyHint else null,
                        onLongClick = row.onLongPress,
                        onClick = row.onTap ?: {}
                    )
                } else Modifier
            )
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(row.label), style = MaterialTheme.typography.labelMedium, color = tokens.textDim)
            Text(
                row.value,
                style = MaterialTheme.typography.bodyLarge,
                color = if (interactive && row.trailing != null && row.trailing != Icons.Outlined.ChevronRight) tokens.accentText else tokens.textStrong
            )
        }
        row.trailing?.let {
            Spacer(Modifier.width(12.dp))
            Icon(it, contentDescription = null, tint = tokens.textSecondary, modifier = Modifier.size(22.dp))
        }
    }
}

/**
 * Самая крупная величина подписи (от labelLarge до 9 sp), при которой все подписи ряда помещаются в
 * плитку одной строкой. Одна на весь ряд — плитки не расходятся по размеру шрифта.
 */
@Composable
private fun rowLabelStyle(labels: List<String>, tileWidth: Dp): TextStyle {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val base = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold)
    val widthPx = with(density) { tileWidth.roundToPx() }.coerceAtLeast(1)
    return remember(labels, widthPx, base, density) {
        var size = base.fontSize.value
        while (size > 9f) {
            val style = base.copy(fontSize = size.sp)
            if (labels.all { measurer.measure(it, style, maxLines = 1, softWrap = false).size.width <= widthPx }) break
            size -= 0.5f
        }
        base.copy(fontSize = size.sp)
    }
}

/** Копия в буфер; телефон и почту система помечает как «секретное» (Android 13+: без превью). */
private fun copyToClipboard(context: android.content.Context, value: String, sensitive: Boolean) {
    val manager = context.getSystemService(android.content.ClipboardManager::class.java) ?: return
    val clip = android.content.ClipData.newPlainText("CentyChat", value)
    if (sensitive && android.os.Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = android.os.PersistableBundle().apply {
            putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    manager.setPrimaryClip(clip)
}

/** Сотрудник не найден (удалён из справочника, нет сети и кэша). */
@Composable
fun PersonNotFound(modifier: Modifier = Modifier) {
    EmptyState(
        illustration = Illustration.SEARCH,
        title = stringResource(R.string.person_not_found),
        message = stringResource(R.string.person_not_found_message),
        modifier = modifier
    )
}
