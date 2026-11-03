package co.x2v.aeeis

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * AEEIS for Android: the inbox and the decisions on it (§11.6 puts these first on a phone), with push for S1 items.
 * Groups, the task board and the studio stay on the web; a block opens its group in the browser.
 */
class MainActivity : ComponentActivity() {
    private var linkedUrl by mutableStateOf<String?>(null)
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Push.initialize(this)
        linkedUrl = intent?.getStringExtra(EXTRA_URL)
        setContent { AeeisTheme { App(Settings(this), linkedUrl, consumeLink = { linkedUrl = null }, askNotifications = ::requestNotifications) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linkedUrl = intent.getStringExtra(EXTRA_URL)
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object { const val EXTRA_URL = "co.x2v.aeeis.url" }
}

@Composable
fun AeeisTheme(content: @Composable () -> Unit) {
    val ink = Color(0xFF171717)
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFEDEDED), onPrimary = ink) else lightColorScheme(primary = ink, onPrimary = Color.White)
    MaterialTheme(colorScheme = scheme, content = content)
}

private sealed interface Screen {
    data object Setup : Screen
    data object Inbox : Screen
    data class Run(val id: String) : Screen
    data object Preferences : Screen
}

/** `/runs/<id>` opens the Run here; anything else (a group) opens in the browser. */
internal fun runIdFromLink(url: String): String? = Regex("^/runs/(run_[0-9a-f-]{36})/?$").find(url)?.groupValues?.get(1)

@Composable
private fun App(settings: Settings, linkedUrl: String?, consumeLink: () -> Unit, askNotifications: () -> Unit) {
    var screen by remember { mutableStateOf(if (settings.configured) Screen.Inbox else Screen.Setup) }
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(linkedUrl) {
        val url = linkedUrl ?: return@LaunchedEffect
        consumeLink()
        if (!settings.configured) return@LaunchedEffect
        val runId = runIdFromLink(url)
        if (runId != null) screen = Screen.Run(runId)
        else context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(settings.client().webUrl(url))))
    }
    when (val current = screen) {
        Screen.Setup -> SetupScreen(settings) { screen = Screen.Inbox; askNotifications() }
        Screen.Inbox -> InboxScreen(settings, open = { item ->
            if (item.runId != null) screen = Screen.Run(item.runId)
            else if (item.roomId != null) context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(settings.client().webUrl("/#room=" + Uri.encode(item.roomId)))))
        }, preferences = { screen = Screen.Preferences })
        is Screen.Run -> {
            BackHandler { screen = Screen.Inbox }
            RunScreen(settings, current.id) { screen = Screen.Inbox }
        }
        Screen.Preferences -> {
            BackHandler { screen = Screen.Inbox }
            PreferencesScreen(settings, back = { screen = Screen.Inbox }, signedOut = { screen = Screen.Setup }, askNotifications = askNotifications)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SetupScreen(settings: Settings, connected: () -> Unit) {
    var server by remember { mutableStateOf(settings.server.ifBlank { "https://" }) }
    var token by remember { mutableStateOf(settings.token) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Scaffold(topBar = { TopAppBar(title = { Text("连接 AEEIS") }) }) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("填你平时打开 AEEIS 的地址。服务端配置了访问令牌时，再填令牌。", style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(server, { server = it }, label = { Text("地址") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth().testTag("server"))
            OutlinedTextField(token, { token = it }, label = { Text("访问令牌（可不填）") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().testTag("token"))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("connect"), onClick = {
                if (!Settings.validServer(server)) { error = "地址要用 https://（只有本机或模拟器的 http://10.0.2.2 可以用 http）"; return@Button }
                busy = true; error = null
                scope.launch {
                    val result = withContext(Dispatchers.IO) { runCatching { AeeisClient(server, token).inbox() } }
                    busy = false
                    result.onSuccess { settings.server = server; settings.token = token; connected() }
                        .onFailure { error = if (it is ApiException && it.status == 401) "令牌不对，或这个 AEEIS 需要令牌。" else "连不上：${it.message}" }
                }
            }) { Text(if (busy) "正在连接…" else "连接") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxScreen(settings: Settings, open: (InboxItem) -> Unit, preferences: () -> Unit) {
    var items by remember { mutableStateOf<List<InboxItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        // Refresh while the inbox is on screen; push covers the time the app is closed.
        while (true) {
            withContext(Dispatchers.IO) { runCatching { settings.client().inbox() } }
                .onSuccess { items = it; error = null }
                .onFailure { error = "刷新失败：${it.message}" }
            delay(15_000)
        }
    }
    Scaffold(topBar = { TopAppBar(title = { Text("收件箱") }, actions = { TextButton(onClick = preferences, modifier = Modifier.testTag("preferences")) { Text("设置") } }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            val list = items
            when {
                list == null -> Row(Modifier.fillMaxWidth().padding(32.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
                list.isEmpty() -> Text("没有要你决定的事。", modifier = Modifier.padding(16.dp).testTag("inbox-empty"), style = MaterialTheme.typography.bodyLarge)
                else -> LazyColumn(Modifier.testTag("inbox")) {
                    items(list, key = { it.key }) { item ->
                        Column(Modifier.fillMaxWidth().clickable { open(item) }.padding(horizontal = 16.dp, vertical = 12.dp)) {
                            Text(when (item.kind) { InboxItem.Kind.APPROVAL -> "等批准"; InboxItem.Kind.QUESTION -> "等回答"; InboxItem.Kind.BLOCK -> "阻塞" }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
                            Text(item.title, style = MaterialTheme.typography.titleMedium)
                            Text(item.detail, style = MaterialTheme.typography.bodyMedium)
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunScreen(settings: Settings, runId: String, back: () -> Unit) {
    var detail by remember { mutableStateOf<RunDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var answer by remember { mutableStateOf("") }
    var feedback by remember { mutableStateOf("") }
    var revising by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(runId, reload) {
        withContext(Dispatchers.IO) { runCatching { settings.client().run(runId) } }.onSuccess { detail = it; error = null }.onFailure { error = "打不开：${it.message}" }
    }
    fun act(done: String, action: suspend () -> Unit) {
        busy = true; error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { action() } }
            busy = false
            result.onSuccess { notice = done; reload++ }.onFailure { error = it.message }
        }
    }
    Scaffold(topBar = { TopAppBar(title = { Text("这件事") }, navigationIcon = { TextButton(onClick = back) { Text("返回") } }) }) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            notice?.let { Text(it, modifier = Modifier.testTag("notice")) }
            val current = detail ?: run { if (error == null) CircularProgressIndicator(); return@Column }
            Text(current.goal, style = MaterialTheme.typography.titleLarge)
            Text(Inbox.statusLabel(current.status), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("status"))
            if (current.planSummary != null || current.steps.isNotEmpty()) Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("计划", style = MaterialTheme.typography.labelLarge)
                    current.planSummary?.let { Text(it) }
                    current.steps.forEachIndexed { index, step -> Text("${index + 1}. ${step.title}", style = MaterialTheme.typography.bodyMedium) }
                }
            }
            when (current.status) {
                "needs_approval" -> {
                    Text("批准后 Bot 按这个计划做。只批这一次的话，下次同样的事还会来问你。", style = MaterialTheme.typography.bodySmall)
                    Button(enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("approve"), onClick = { act("已批准，Bot 开始做了。") { settings.client().approve(current, once = false) } }) { Text("批准并执行") }
                    OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { act("已批准这一次。") { settings.client().approve(current, once = true) } }) { Text("只批这一次") }
                    OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { revising = true }) { Text("打回，说明要改什么") }
                }
                "needs_input" -> {
                    Text(current.question ?: "Bot 需要一条补充信息才能继续。", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("question"))
                    OutlinedTextField(answer, { answer = it }, label = { Text("你的回答") }, modifier = Modifier.fillMaxWidth().testTag("answer"), minLines = 2)
                    Button(enabled = !busy && answer.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("send-answer"), onClick = { act("已回答，Bot 接着做。") { settings.client().answer(current.id, answer.trim()); answer = "" } }) { Text("回答并继续") }
                }
                else -> current.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            Spacer(Modifier.width(1.dp))
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(settings.client().webUrl("/runs/${current.id}")))) }) { Text("在网页版看完整过程") }
            if (revising) AlertDialog(
                onDismissRequest = { revising = false },
                title = { Text("打回计划") },
                text = { OutlinedTextField(feedback, { feedback = it }, label = { Text("要改什么") }, minLines = 3, modifier = Modifier.fillMaxWidth()) },
                confirmButton = { TextButton(enabled = feedback.isNotBlank(), onClick = { revising = false; act("已打回，Bot 会重新做计划。") { settings.client().revise(current, feedback.trim()); feedback = "" } }) { Text("打回") } },
                dismissButton = { TextButton(onClick = { revising = false }) { Text("取消") } },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PreferencesScreen(settings: Settings, back: () -> Unit, signedOut: () -> Unit, askNotifications: () -> Unit) {
    var pushOn by remember { mutableStateOf(settings.pushSubscriptionId.isNotBlank()) }
    var note by remember { mutableStateOf<String?>(null) }
    var serverFcm by remember { mutableStateOf<Boolean?>(null) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(Unit) { serverFcm = withContext(Dispatchers.IO) { runCatching { "fcm" in settings.client().pushChannels() }.getOrDefault(false) } }
    Scaffold(topBar = { TopAppBar(title = { Text("设置") }, navigationIcon = { TextButton(onClick = back) { Text("返回") } }) }) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("连接到 ${settings.server}", style = MaterialTheme.typography.bodyMedium)
            HorizontalDivider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("推送要你决定的事", style = MaterialTheme.typography.titleMedium)
                    Text("审批、提问和群里的阻塞。app 关着也提醒，同一件事只提醒一次。", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = pushOn, enabled = Push.built && serverFcm == true, modifier = Modifier.testTag("push"), onCheckedChange = { wanted ->
                    scope.launch {
                        val result = withContext(Dispatchers.IO) { runCatching { if (wanted) Push.enable(context, settings) else Push.disable(settings) } }
                        result.onSuccess { pushOn = wanted; note = if (wanted) "已打开推送。" else "已关闭推送。"; if (wanted) askNotifications() }
                            .onFailure { note = "没能${if (wanted) "打开" else "关闭"}：${it.message}" }
                    }
                })
            }
            val why = when {
                !Push.built -> "这个版本没有配置推送（需要 Firebase 项目）。app 开着时收件箱照样刷新。"
                serverFcm == false -> "这个 AEEIS 没有打开 Android 推送（服务端要配 FCM）。"
                else -> note
            }
            why?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("push-note")) }
            HorizontalDivider()
            OutlinedButton(onClick = {
                scope.launch {
                    withContext(Dispatchers.IO) { runCatching { Push.disable(settings) } }
                    settings.clear(); signedOut()
                }
            }) { Text("断开这个 AEEIS") }
        }
    }
}
