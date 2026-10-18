/**
 * 「音乐小节线」组件 —— 通过 B 站 API 拉取视频标题/封面/bv/aid。
 * 使用明确记录的 BV/AV 号查询，不能把配置 key（通常为 cid）当作 aid。
 */

import { getJsonWithCredentials } from '@/core/ajax'
import { BarConfig } from './config'

export const fetchVideoMeta = async (
  aid?: string,
  bvid?: string,
): Promise<Partial<Pick<BarConfig, 'videoTitle' | 'videoCover' | 'bvid' | 'aid'>> | null> => {
  let query = ''
  if (/^BV[0-9a-zA-Z]{10}$/.test(bvid || '')) {
    query = `bvid=${bvid}`
  } else if (/^[1-9]\d*$/.test(aid || '')) {
    query = `aid=${aid}`
  }
  if (!query) {
    return null
  }
  try {
    const json = await getJsonWithCredentials(
      `https://api.bilibili.com/x/web-interface/view?${query}`,
    )
    if (json.code !== 0) {
      return null
    }
    const { data } = json
    if (!data?.title || !data.pic || !data.bvid || !data.aid) {
      return null
    }
    return {
      videoTitle: data?.title,
      videoCover: (data?.pic || '').replace('http:', 'https:'),
      bvid: data?.bvid,
      aid: String(data?.aid),
    }
  } catch {
    return null
  }
}
