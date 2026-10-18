/**
 * 「音乐小节线」组件入口。
 *
 * 依赖的框架 API：
 * - defineComponentMetadata / defineOptionsMetadata 来自 `@/components/define`
 * - videoChange 来自 `@/core/observer`
 * - addControlBarButton 来自 `@/components/video/video-control-bar`
 * - playerAgent 来自 `@/components/video/player-agent`
 */

import {
  defineComponentMetadata,
  defineOptionsMetadata,
  OptionsOfMetadata,
} from '@/components/define'
import { videoChange } from '@/core/observer'
import { addControlBarButton } from '@/components/video/video-control-bar'
import type { VideoControlBarItem } from '@/components/video/video-control-bar'
import { addComponentListener, removeComponentListener } from '@/core/settings'
import type { ComponentSettings } from '@/core/settings/types'
import { playerAgent } from '@/components/video/player-agent'
import { getActiveElement, isTyping, playerReady } from '@/core/utils'
import { addData } from '@/plugins/data'
import { playerUrls } from '@/core/utils/urls'
import { showDialog } from '@/core/dialog'
import { Toast } from '@/core/toast'
import { select, hasVideo } from '@/core/spin-query'
import {
  BarConfig,
  DEFAULT_CONFIG,
  TimeSignatureSegment,
  barStartTime,
  beatNumberAt,
  deleteConfig,
  initStore,
  loadConfig,
  locateBar,
  saveConfig,
  setVideoMeta,
  segmentAt,
  touchOpened,
} from './config'
import { Metronome } from './metronome'
import { fetchVideoMeta } from './video-fetch'
import { BarSwipe } from './swipe'
import { SegmentMarkerOverlay, ensureStyles } from './ui'
import pencilIcon from './pencil.svg'
import metronomeOnIcon from './metronome.svg'
import metronomeOffIcon from './metronome-off.svg'
import prevIcon from './prev.svg'
import nextIcon from './next.svg'
import firstIcon from './first.svg'
import loopOffIcon from './loop-off.svg'
import loopPendingIcon from './loop-pending.svg'
import loopOnIcon from './loop-on.svg'

const options = defineOptionsMetadata({
  configs: {
    defaultValue: '{}',
    displayName: '小节线配置',
    hidden: true,
  },
  hideBarNavButtons: {
    displayName: '隐藏上下小节按钮',
    defaultValue: false,
  },
  loopDisableCountIn: {
    displayName: '循环段禁用预备拍',
    defaultValue: false,
  },
  countInMaxVolume: {
    displayName: '预备拍使用最大音量',
    defaultValue: true,
  },
  promptMetronomeVolume: {
    displayName: '弹窗设置节拍器音量',
    defaultValue: false,
  },
})
export type BarLineOptions = OptionsOfMetadata<typeof options>

const BODY_CLASS = 'barline-active'
const CONFIGURED_CLASS = 'barline-configured'
const METRONOME_CLASS = 'barline-metronome-on'
const METRONOME_SELECTOR = '.be-video-control-bar-extend [data-name="barLineMetronome"]'

let enabled = false
let metronome: Metronome | null = null
let overlay: SegmentMarkerOverlay | null = null
let metronomeButton: VideoControlBarItem | null = null
let loopButton: VideoControlBarItem | null = null
let currentVideo: HTMLVideoElement | null = null
let currentConfig: BarConfig | null = null
let currentKey = ''
let currentVideoMeta: Partial<Pick<BarConfig, 'aid' | 'bvid' | 'videoTitle' | 'videoCover'>> = {}
let editClose: (() => void) | null = null
let syncToken = 0
let loopStart: number | null = null
let loopEnd: number | null = null
let loopStartBar: number | null = null
let loopEndBar: number | null = null
let loopState: 'off' | 'pending' | 'looping' = 'off'
let loopCleanup: (() => void) | null = null
let playCleanup: (() => void) | null = null
let countInBeat: number | null = null
let beatDisplayRaf = 0
let lastBeatIcon = ''
let volumeTooltip: { tippy: { destroy: () => void } } | null = null
let volumeSliderRefresh: (() => void) | null = null
let barSwipe: BarSwipe | null = null
let resetLoop: () => void
let settingsRef: ComponentSettings<BarLineOptions>['options'] | null = null
let listenerHandlers: Array<() => void> | null = null

const isLoopCountInDisabled = () => Boolean(settingsRef?.loopDisableCountIn)

// 默认开启：settingsRef 尚未就绪时按开启处理。
const isCountInMaxVolume = () => settingsRef?.countInMaxVolume !== false

const beatIconName = (n: number) => (n >= 0 ? `barline-beat-${n}` : `barline-beat-neg${-n}`)

const beatIconSvg = (n: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="16.5" font-size="15" font-weight="600" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" fill="currentColor">${n}</text></svg>`

const tickBeatDisplay = () => {
  beatDisplayRaf = 0
  if (!enabled) {
    return
  }
  let icon: string
  if (countInBeat !== null) {
    icon = beatIconName(countInBeat)
  } else if (currentConfig?.metronomeMuted) {
    icon = 'barline-metronome-off'
  } else if (currentVideo) {
    // 播放中显示第几拍；暂停或还没到第一拍时显示节拍器图标。
    if (currentConfig && currentVideo.paused === false) {
      const beat = beatNumberAt(currentConfig, currentVideo.currentTime)
      icon = beat !== null ? beatIconName(beat) : 'barline-metronome-on'
    } else {
      icon = 'barline-metronome-on'
    }
  } else {
    icon = 'barline-metronome-off'
  }
  if (metronomeButton && icon !== lastBeatIcon) {
    metronomeButton.icon = icon
    lastBeatIcon = icon
  }
  beatDisplayRaf = requestAnimationFrame(tickBeatDisplay)
}

const startBeatDisplay = () => {
  if (beatDisplayRaf) {
    return
  }
  lastBeatIcon = ''
  beatDisplayRaf = requestAnimationFrame(tickBeatDisplay)
}

const stopBeatDisplay = () => {
  if (beatDisplayRaf) {
    cancelAnimationFrame(beatDisplayRaf)
    beatDisplayRaf = 0
  }
  lastBeatIcon = ''
}

const setBodyState = (configured: boolean, unmuted: boolean) => {
  document.body.classList.toggle(CONFIGURED_CLASS, configured)
  document.body.classList.toggle(METRONOME_CLASS, unmuted)
}

const updateLoopIcon = () => {
  if (!loopButton) {
    return
  }
  if (loopState === 'pending') {
    loopButton.icon = 'barline-loop-pending'
    loopButton.displayName = '设置循环终点'
  } else if (loopState === 'looping') {
    loopButton.icon = 'barline-loop-on'
    loopButton.displayName = '关闭循环'
  } else {
    loopButton.icon = 'barline-loop-off'
    loopButton.displayName = '设置循环起点'
  }
}

const clearUiState = () => {
  editClose?.()
  editClose = null
  overlay?.destroy()
  overlay = null
  playCleanup?.()
  playCleanup = null
  countInBeat = null
  resetLoop()
  setBodyState(false, false)
}

export const openManager = () => {
  if (editClose) {
    return
  }
  const dialog = showDialog({
    title: '管理小节线',
    content: () => import('./BarLineManager.vue'),
  })
  dialog.$el?.classList.add('barline-dialog', 'barline-manage-dialog')
  editClose = () => dialog.close()
  dialog.closeListeners.push(() => {
    editClose = null
  })
}

export const openEditor = () => {
  if (!currentVideo || editClose) {
    return
  }
  const video = currentVideo
  const initial = currentConfig || DEFAULT_CONFIG
  const dialog = showDialog({
    title: '音乐小节线设置',
    content: () => import('./BarLineEditor.vue'),
    contentProps: {
      video,
      initial,
      hasConfig: Boolean(currentConfig),
      // 配置实时生效：每次编辑立即保存并应用，无需「保存」按钮。
      onPreview: (draft: BarConfig) => {
        currentConfig = { ...draft, ...currentVideoMeta }
        if (currentKey) {
          // 记录当前视频的 aid/bvid，供「管理小节线」显示标题/封面/跳转。
          saveConfig(currentKey, currentConfig)
        }
        metronome?.setConfig(draft)
        metronome?.setMuted(draft.metronomeMuted)
        metronome?.setVolume(draft.metronomeVolume)
        overlay?.setConfig(draft)
        setBodyState(true, !draft.metronomeMuted)
      },
      // 「临时关闭节拍器」：只实时静音/恢复，不写入配置。
      onTempMute: (muted: boolean) => {
        metronome?.setMuted(muted)
      },
      onDelete: () => {
        if (currentKey) {
          deleteConfig(currentKey)
        }
        currentConfig = null
        metronome?.setConfig(null)
        metronome?.setMuted(true)
        overlay?.setDraft(null)
        overlay?.setConfig(null)
        setBodyState(false, false)
      },
    },
  })
  dialog.$el?.classList.add('barline-dialog')
  editClose = () => dialog.close()
  dialog.closeListeners.push(() => {
    overlay?.setDraft(null)
    editClose = null
    // 关闭窗口后恢复节拍器到配置的真实静音状态（解除「临时关闭」）。
    if (currentConfig) {
      metronome?.setMuted(currentConfig.metronomeMuted)
      setBodyState(true, !currentConfig.metronomeMuted)
    }
  })
}

const applyVolume = (volume: number) => {
  if (currentConfig) {
    currentConfig.metronomeVolume = volume
    currentConfig.metronomeMuted = volume <= 0
  }
  metronome?.setVolume(volume)
  metronome?.setMuted(volume <= 0)
  setBodyState(Boolean(currentConfig), volume > 0)
}

const persistVolume = (volume: number) => {
  if (currentConfig && currentKey) {
    currentConfig.metronomeVolume = volume
    currentConfig.metronomeMuted = volume <= 0
    saveConfig(currentKey, currentConfig)
  }
}

const toggleMute = () => {
  if (!currentConfig || !currentKey) {
    return
  }
  // 「弹窗设置节拍器音量」开启时：用 prompt 设置音量（0-100），不再切换静音。
  if (settingsRef?.promptMetronomeVolume) {
    const current = Math.round((currentConfig.metronomeVolume ?? 1) * 100)
    const input = prompt('设置节拍器音量 (0-100)', String(current))
    if (input === null) {
      return
    }
    const n = Number(input)
    if (Number.isNaN(n)) {
      return
    }
    const clamped = Math.min(100, Math.max(0, n))
    const volume = clamped / 100
    currentConfig = { ...currentConfig, metronomeVolume: volume, metronomeMuted: volume <= 0 }
    saveConfig(currentKey, currentConfig)
    metronome?.setVolume(volume)
    metronome?.setMuted(volume <= 0)
    setBodyState(true, volume > 0)
    volumeSliderRefresh?.()
    return
  }
  const willMute = !currentConfig.metronomeMuted
  let volume = currentConfig.metronomeVolume
  // 取消静音时，若之前音量被手动调为 0，则恢复到 10，避免取消静音后仍然无声。
  if (!willMute && volume <= 0) {
    volume = 0.1
  }
  currentConfig = { ...currentConfig, metronomeMuted: willMute, metronomeVolume: volume }
  saveConfig(currentKey, currentConfig)
  metronome?.setMuted(willMute)
  metronome?.setVolume(volume)
  setBodyState(true, !willMute)
  volumeSliderRefresh?.()
}

const buildVolumeSlider = (): { el: HTMLElement; refresh: () => void } => {
  const el = document.createElement('div')
  el.className = 'barline-volume-vertical'
  const number = document.createElement('div')
  number.className = 'barline-volume-number'
  const track = document.createElement('div')
  track.className = 'barline-volume-track'
  const fill = document.createElement('div')
  fill.className = 'barline-volume-fill'
  const thumb = document.createElement('div')
  thumb.className = 'barline-volume-thumb'
  track.append(fill, thumb)
  el.append(number, track)

  const setFill = (value: number) => {
    number.textContent = String(value)
    fill.style.height = `${value}%`
    thumb.style.bottom = `${value}%`
  }
  const volumeFromY = (clientY: number) => {
    const rect = track.getBoundingClientRect()
    const ratio = 1 - (clientY - rect.top) / rect.height
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
  }
  const refresh = () => {
    const muted =
      !currentConfig ||
      Boolean(currentConfig?.metronomeMuted) ||
      (currentConfig?.metronomeVolume ?? 1) <= 0
    const value = muted ? 0 : Math.round((currentConfig?.metronomeVolume ?? 1) * 100)
    setFill(value)
  }

  track.addEventListener('mousedown', e => {
    const commit = (clientY: number) => {
      const v = volumeFromY(clientY)
      setFill(v)
      applyVolume(v / 100)
    }
    commit(e.clientY)
    const onMove = (ev: MouseEvent) => commit(ev.clientY)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      persistVolume(currentConfig?.metronomeVolume ?? 1)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })

  refresh()
  return { el, refresh }
}

const setupVolumeTooltip = async () => {
  if (volumeTooltip) {
    return
  }
  const btn = await select<HTMLElement>(METRONOME_SELECTOR)
  if (!btn) {
    return
  }
  const { el, refresh } = buildVolumeSlider()
  volumeSliderRefresh = refresh
  volumeTooltip = Toast.mini(el, btn, {
    trigger: 'mouseenter focus',
    hideOnClick: false,
    interactive: true,
    placement: 'top',
    arrow: false,
    onShow: () => refresh(),
    onShown: () => refresh(),
  })
}

/** 根据「弹窗设置节拍器音量」设置，切换节拍器按钮名称与 hover 滑块。 */
const applyMetronomeButtonState = () => {
  const promptMode = Boolean(settingsRef?.promptMetronomeVolume)
  if (metronomeButton) {
    // 开启弹窗设置：按钮名「节拍器」；关闭：空名（hover 滑块）。
    metronomeButton.displayName = promptMode ? '节拍器' : ''
  }
  if (promptMode) {
    // 弹窗设置开启：不显示 hover 滑块。
    volumeTooltip?.tippy.destroy()
    volumeTooltip = null
    volumeSliderRefresh = null
  } else {
    // 弹窗设置关闭：显示 hover 滑块。
    setupVolumeTooltip()
  }
}

const seekToBar = (direction: -1 | 1) => {
  if (!currentConfig || !currentVideo) {
    return
  }
  const t = currentVideo.currentTime
  const loc = locateBar(currentConfig, t)
  if (direction > 0) {
    if (!loc) {
      const first = barStartTime(currentConfig, 1)
      if (first !== null) {
        currentVideo.currentTime = first
      }
      return
    }
    const next = barStartTime(currentConfig, loc.bar + 1)
    if (next !== null) {
      currentVideo.currentTime = next
    }
  } else if (!loc) {
    currentVideo.currentTime = 0
  } else {
    // 始终回退一整小节
    const prevBar = loc.bar - 1
    currentVideo.currentTime = prevBar >= 1 ? barStartTime(currentConfig, prevBar) ?? 0 : 0
  }
}

const runCountIn = (segment: TimeSignatureSegment, onComplete: () => void) => {
  if (!metronome) {
    onComplete()
    return
  }
  metronome.setCountInMaxVolume(isCountInMaxVolume())
  metronome.countIn(
    segment,
    beat => {
      countInBeat = beat
    },
    () => {
      countInBeat = null
      onComplete()
    },
  )
}

const jumpWithCountIn = (time: number, segment: TimeSignatureSegment) => {
  if (!currentVideo) {
    return
  }
  const wasPlaying = !currentVideo.paused
  currentVideo.pause()
  currentVideo.currentTime = time
  if (wasPlaying) {
    runCountIn(segment, () => {
      currentVideo?.play()
    })
  }
}

const jumpToFirstBeat = () => {
  if (!currentConfig || !currentConfig.segments.length) {
    return
  }
  const first = currentConfig.segments[0]
  jumpWithCountIn(first.firstBeatTime ?? 0, first)
}

resetLoop = () => {
  loopCleanup?.()
  loopCleanup = null
  loopStart = null
  loopEnd = null
  loopStartBar = null
  loopEndBar = null
  loopState = 'off'
  updateLoopIcon()
  overlay?.redraw()
}

const startLooping = () => {
  loopCleanup?.()
  loopCleanup = null
  const video = currentVideo
  if (!video) {
    return
  }
  let inCountIn = false
  const handler = () => {
    if (inCountIn) {
      return
    }
    if (!currentConfig || loopStart === null || loopEnd === null || loopEnd <= loopStart) {
      return
    }
    if (video.currentTime >= loopEnd) {
      inCountIn = true
      const start = loopStart
      const segment = segmentAt(currentConfig, start)
      video.pause()
      video.currentTime = start
      // 跳回起点后重新对齐下一拍，避免节拍器网格错乱而不发声。
      metronome?.resync()
      const resume = () => {
        inCountIn = false
        video.play()
      }
      if (segment && !isLoopCountInDisabled()) {
        runCountIn(segment, resume)
      } else {
        resume()
      }
    }
  }
  video.addEventListener('timeupdate', handler)
  loopCleanup = () => video.removeEventListener('timeupdate', handler)
}

const toggleLoop = () => {
  if (!currentConfig || !currentVideo) {
    return
  }
  const loc = locateBar(currentConfig, currentVideo.currentTime)
  const barStart = loc ? loc.startTime : 0
  const barNumber = loc ? loc.bar : 1
  if (loopState === 'off') {
    loopStart = barStart
    loopStartBar = barNumber
    loopState = 'pending'
  } else if (loopState === 'pending') {
    loopEnd = barStart
    loopEndBar = barNumber
    if (loopEnd < loopStart) {
      const tmp = loopStart
      loopStart = loopEnd
      loopEnd = tmp
      const tmpBar = loopStartBar
      loopStartBar = loopEndBar
      loopEndBar = tmpBar
    }
    loopState = 'looping'
    startLooping()
    const start = loopStart ?? 0
    const wasPlaying = !currentVideo.paused
    currentVideo.pause()
    currentVideo.currentTime = start
    if (wasPlaying) {
      const segment = segmentAt(currentConfig, start)
      if (segment && !isLoopCountInDisabled()) {
        runCountIn(segment, () => {
          currentVideo?.play()
        })
      } else {
        currentVideo.play()
      }
    }
  } else {
    resetLoop()
    return
  }
  updateLoopIcon()
  overlay?.redraw()
}

const shouldIgnoreKey = () => {
  if (isTyping()) {
    return true
  }
  const active = getActiveElement()
  if (!active || active === document.body) {
    return false
  }
  if (active instanceof HTMLMediaElement) {
    return false
  }
  if (active instanceof HTMLDivElement && active.classList.contains('bpx-player-ctrl-btn')) {
    return false
  }
  if (active instanceof HTMLInputElement && active.classList.contains('bui')) {
    return false
  }
  return true
}

const onKeydown = (e: KeyboardEvent) => {
  if (!enabled || !currentConfig || !currentVideo) {
    return
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
    return
  }
  if (editClose) {
    return
  }
  if (shouldIgnoreKey()) {
    return
  }
  e.preventDefault()
  e.stopImmediatePropagation()
  seekToBar(e.key === 'ArrowRight' ? 1 : -1)
}

const sync = async (id: { aid?: string; cid?: string }) => {
  if (!enabled) {
    return
  }
  // 兜底：确保样式已注入（编辑弹窗、音量滑块、进度条标记都依赖它）。
  ensureStyles()
  resetLoop()
  const token = ++syncToken
  const video = (await playerAgent.query.video.element()) as HTMLVideoElement | null
  if (!enabled || token !== syncToken) {
    return
  }
  currentVideo = video
  currentKey = id.cid || id.aid || ''
  // videoChange 的 aid 跟随播放器切换；页面全局变量在合集/嵌入播放器中可能缺失或过期。
  const pathId = location.pathname.match(/\/video\/(BV[0-9a-zA-Z]{10}|av\d+)/)?.[1]
  currentVideoMeta = {}
  if (id.aid) {
    currentVideoMeta.aid = String(id.aid)
  } else if (pathId?.startsWith('av')) {
    currentVideoMeta.aid = pathId.slice(2)
  } else if (pathId) {
    currentVideoMeta.bvid = pathId
  }
  currentConfig = currentKey ? loadConfig(currentKey) : null
  if (currentKey && currentConfig) {
    setVideoMeta(currentKey, currentVideoMeta)
    currentConfig = { ...currentConfig, ...currentVideoMeta }
    // 记录「最后打开时间」。
    touchOpened(currentKey)
  }
  // 无配置时也预取，首次编辑即可保存完整信息。异步结果不能写到切换后的视频。
  const metaKey = currentKey
  fetchVideoMeta(currentVideoMeta.aid, currentVideoMeta.bvid).then(meta => {
    if (!meta || !enabled || token !== syncToken) {
      return
    }
    currentVideoMeta = meta
    setVideoMeta(metaKey, meta)
    if (currentConfig) {
      currentConfig = { ...currentConfig, ...meta }
    }
  })

  metronome?.setVideo(video)
  metronome?.setConfig(currentConfig)
  // 无配置时也保持静音（不发声），符合「节拍器默认静音」。
  metronome?.setMuted(Boolean(!currentConfig || currentConfig?.metronomeMuted))
  metronome?.setVolume(currentConfig?.metronomeVolume ?? 1)
  volumeSliderRefresh?.()

  // 用户在预备拍期间手动恢复播放时，立即停止预备拍，改为跟随视频进度。
  playCleanup?.()
  playCleanup = null
  if (video) {
    const handler = () => {
      if (countInBeat !== null && metronome) {
        metronome.cancelCountIn()
        countInBeat = null
        // 手动恢复播放后，重新对齐下一拍，保证节拍器继续发声。
        metronome.resync()
      }
    }
    video.addEventListener('play', handler)
    playCleanup = () => video.removeEventListener('play', handler)
  }

  overlay?.destroy()
  overlay = null
  barSwipe?.destroy()
  barSwipe = null
  if (video) {
    const progress = await playerAgent.query.control.progress()
    if (!enabled || token !== syncToken) {
      return
    }
    if (progress) {
      overlay = new SegmentMarkerOverlay(progress, video, () => ({
        start: loopStartBar,
        end: loopEndBar,
      }))
      overlay.setConfig(currentConfig)
    }
    const container = playerAgent.query.video.container.sync()
    if (container) {
      // 触屏左右滑动跳小节：仅在已配置小节的视频生效。
      barSwipe = new BarSwipe(container, {
        getConfig: () => currentConfig,
        isActive: () => enabled && Boolean(currentConfig),
        onTarget: time => {
          if (currentVideo) {
            const wasPaused = currentVideo.paused
            currentVideo.currentTime = time
            // 若原本暂停，跳转后保持暂停；若原本播放则不受影响。
            if (wasPaused && !currentVideo.paused) {
              currentVideo.pause()
            }
          }
        },
      })
      barSwipe.attach()
    }
  }
  setBodyState(Boolean(currentConfig), !currentConfig?.metronomeMuted)
}

/** 注册设置监听，重新开启组件时也会重新注册。 */
const setupSettingsListeners = () => {
  listenerHandlers?.forEach(remove => remove())
  listenerHandlers = []

  // 监听「隐藏上下小节按钮」设置，动态隐藏/显示上一小节/下一小节按钮。
  const onHideBarNavChanged: Parameters<typeof addComponentListener>[1] = value => {
    document.body.classList.toggle('barline-hide-bar-nav', Boolean(value))
  }
  addComponentListener('barline.hideBarNavButtons', onHideBarNavChanged, true)
  listenerHandlers.push(() =>
    removeComponentListener('barline.hideBarNavButtons', onHideBarNavChanged),
  )

  // 监听「弹窗设置节拍器音量」，切换按钮名称与 hover 滑块。
  const onPromptVolumeChanged: Parameters<typeof addComponentListener>[1] = () => {
    applyMetronomeButtonState()
  }
  addComponentListener('barline.promptMetronomeVolume', onPromptVolumeChanged, true)
  listenerHandlers.push(() =>
    removeComponentListener('barline.promptMetronomeVolume', onPromptVolumeChanged),
  )
}

const entry = async ({ settings }: { settings: ComponentSettings<BarLineOptions> }) => {
  initStore(settings)
  settingsRef = settings.options
  enabled = true
  document.body.classList.add(BODY_CLASS)
  ensureStyles()
  addData('ui.icons', (icons: Record<string, string>) => {
    if (!icons['barline-pencil']) {
      icons['barline-pencil'] = pencilIcon
    }
    icons['barline-metronome-on'] = metronomeOnIcon
    icons['barline-metronome-off'] = metronomeOffIcon
    icons['barline-prev'] = prevIcon
    icons['barline-next'] = nextIcon
    icons['barline-first'] = firstIcon
    icons['barline-loop-off'] = loopOffIcon
    icons['barline-loop-pending'] = loopPendingIcon
    icons['barline-loop-on'] = loopOnIcon
    for (let i = 1; i <= 32; i += 1) {
      icons[`barline-beat-${i}`] = beatIconSvg(i)
      icons[`barline-beat-neg${i}`] = beatIconSvg(-i)
    }
  })
  await playerReady()
  metronome = new Metronome()
  metronomeButton = {
    name: 'barLineMetronome',
    displayName: '',
    icon: 'barline-metronome-off',
    order: 2,
    action: toggleMute,
  }
  addControlBarButton(metronomeButton)
  addControlBarButton({
    name: 'barLineFirst',
    displayName: '跳到第一拍',
    icon: 'barline-first',
    order: 3,
    action: jumpToFirstBeat,
  })
  addControlBarButton({
    name: 'barLinePrev',
    displayName: '上一小节',
    icon: 'barline-prev',
    order: 4,
    action: () => seekToBar(-1),
  })
  addControlBarButton({
    name: 'barLineNext',
    displayName: '下一小节',
    icon: 'barline-next',
    order: 5,
    action: () => seekToBar(1),
  })
  loopButton = {
    name: 'barLineLoop',
    displayName: '循环',
    icon: 'barline-loop-off',
    order: 6,
    action: toggleLoop,
  }
  addControlBarButton(loopButton)
  window.addEventListener('keydown', onKeydown, true)
  startBeatDisplay()
  setupSettingsListeners()
  await videoChange(sync)
}

const reload = () => {
  enabled = true
  document.body.classList.add(BODY_CLASS)
  window.addEventListener('keydown', onKeydown, true)
  setupSettingsListeners()
  if (!metronome) {
    metronome = new Metronome()
  }
  startBeatDisplay()
  sync({ aid: unsafeWindow.aid, cid: unsafeWindow.cid })
}

const unload = () => {
  enabled = false
  stopBeatDisplay()
  clearUiState()
  document.body.classList.remove(BODY_CLASS, 'barline-hide-bar-nav')
  window.removeEventListener('keydown', onKeydown, true)
  barSwipe?.destroy()
  barSwipe = null
  listenerHandlers?.forEach(remove => remove())
  listenerHandlers = null
  volumeTooltip?.tippy.destroy()
  volumeTooltip = null
  volumeSliderRefresh = null
  settingsRef = null
  metronome?.dispose()
  metronome = null
  currentVideo = null
  currentConfig = null
  currentKey = ''
  syncToken += 1
}

export const component = defineComponentMetadata({
  name: 'barline',
  displayName: '音乐小节线',
  author: {
    name: 'sh311',
    link: 'https://gitee.com/m1ku666',
  },
  tags: [componentsTags.video],
  options,
  entry,
  reload,
  unload,
  widget: {
    condition: hasVideo,
    component: () => import('./BarLineWidget.vue').then(m => m.default),
  },
  urlInclude: playerUrls,
})
