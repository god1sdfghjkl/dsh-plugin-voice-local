/**
 * ToneSandhi 变调器 · 从 Python 版逐行移植
 * （原版权：PaddlePaddle Authors, Apache-2.0；与 tts_onnx/text/tone_sandhi.py 对齐）
 *
 * 数据来自 lib/tts-text/sandhi_words.json；
 * 拼音查表来自 resolved_phrases/resolved_chars（pypinyin 最终输出导出）。
 */

const isNumericChar = (c) => /\d/.test(c) || '〇零一二三四五六七八九十百千万亿兆两'.includes(c)
const isNumericWord = (w) => [...w].every(isNumericChar)

export class ToneSandhi {
  constructor(words, pinyinResolver, jieba) {
    this._jieba = jieba
    this.mustNeural = new Set(words.must_neural)
    this.mustNotNeural = new Set(words.must_not_neural)
    this.punc = words.punc
    this.py = pinyinResolver            // word -> {i:[], f:[]} | null
  }

  // 与 pypinyin lazy_pinyin(neutral_tone_with_five=True, style=FINALS_TONE3) 等价
  _finalsOf(word) {
    const r = this.py(word)
    return r ? r.f.slice() : null
  }

  _neuralSandhi(word, pos, finals) {
    // 叠字轻声：奶奶 / 试试 / 旺旺（n. v. a. 开头的词性）
    for (let j = 0; j < word.length; j++) {
      if (
        j - 1 >= 0 &&
        word[j] === word[j - 1] &&
        'nva'.includes(pos[0]) &&
        !this.mustNotNeural.has(word)
      ) {
        finals[j] = finals[j].slice(0, -1) + '5'
      }
    }
    const geIdx = word.indexOf('个')
    if (word.length >= 1 && '吧呢啊呐噻嘛吖嗨呐哦哒额滴哩哟喽啰耶喔诶'.includes(word[word.length - 1])) {
      finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
    } else if (word.length >= 1 && '的地得'.includes(word[word.length - 1])) {
      finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
    } else if (
      word.length > 1 &&
      '们子'.includes(word[word.length - 1]) &&
      (pos === 'r' || pos === 'n') &&
      !this.mustNotNeural.has(word)
    ) {
      finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
    } else if (
      word.length > 1 &&
      '上下里'.includes(word[word.length - 1]) &&
      (pos === 's' || pos === 'l' || pos === 'f')
    ) {
      finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
    } else if (
      word.length > 1 &&
      '来去'.includes(word[word.length - 1]) &&
      '上下进出回过起开'.includes(word[word.length - 2])
    ) {
      finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
    } else if (
      word === '个' ||
      (geIdx >= 1 &&
      (isNumericChar(word[geIdx - 1]) || '几有两半多各整每做是'.includes(word[geIdx - 1])))
    ) {
      finals[geIdx] = finals[geIdx].slice(0, -1) + '5'
    } else {
      if (
        this.mustNeural.has(word) ||
        this.mustNeural.has(word.slice(-2))
      ) {
        finals[finals.length - 1] = finals[finals.length - 1].slice(0, -1) + '5'
      }
    }
    const wordList = this._splitWord(word)
    const finalsList = [finals.slice(0, wordList[0].length), finals.slice(wordList[0].length)]
    for (let i = 0; i < wordList.length; i++) {
      const w = wordList[i]
      if (this.mustNeural.has(w) || this.mustNeural.has(w.slice(-2))) {
        const arr = finalsList[i]
        arr[arr.length - 1] = arr[arr.length - 1].slice(0, -1) + '5'
      }
    }
    return finalsList.flat()
  }

  _buSandhi(word, finals) {
    // 看不懂
    if (word.length === 3 && word[1] === '不') {
      finals[1] = finals[1].slice(0, -1) + '5'
    } else {
      for (let i = 0; i < word.length; i++) {
        // 不+四声 → 二声，如 不怕
        if (word[i] === '不' && i + 1 < word.length && finals[i + 1].endsWith('4')) {
          finals[i] = finals[i].slice(0, -1) + '2'
        }
      }
    }
    return finals
  }

  _yiSandhi(word, finals) {
    // 数字串里的一，如 一零零 / 二一零
    if (word.includes('一') && [...word].every((c) => c === '一' || isNumericChar(c))) {
      return finals
    }
    // 重叠动词中间的一：看一看 → yi5
    if (word.length === 3 && word[1] === '一' && word[0] === word[2]) {
      finals[1] = finals[1].slice(0, -1) + '5'
    } else if (word.startsWith('第一')) {
      // 序数词保持一声
      finals[1] = finals[1].slice(0, -1) + '1'
    } else {
      for (let i = 0; i < word.length; i++) {
        if (word[i] === '一' && i + 1 < word.length) {
          if (finals[i + 1].endsWith('4')) {
            // 一段 → yi2
            finals[i] = finals[i].slice(0, -1) + '2'
          } else if (!this.punc.includes(word[i + 1])) {
            // 一天 → yi4（后面是标点则仍读一声）
            finals[i] = finals[i].slice(0, -1) + '4'
          }
        }
      }
    }
    return finals
  }

  _splitWord(word) {
    // jieba cut_for_search + 按长度升序，取最短子词定位切分
    const list = this._jieba.cutForSearch(word)
      .slice()
      .sort((a, b) => a.length - b.length)
    const first = list[0]
    const idx = word.indexOf(first)
    if (idx === 0) {
      return [first, word.slice(first.length)]
    }
    return [word.slice(0, word.length - first.length), first]
  }

  _threeSandhi(word, finals) {
    if (word.length === 2 && this._allToneThree(finals)) {
      finals[0] = finals[0].slice(0, -1) + '2'
    } else if (word.length === 3) {
      const wordList = this._splitWord(word)
      if (this._allToneThree(finals)) {
        // 双字+单字，如 蒙古/包
        if (wordList[0].length === 2) {
          finals[0] = finals[0].slice(0, -1) + '2'
          finals[1] = finals[1].slice(0, -1) + '2'
        } else if (wordList[0].length === 1) {
          // 单字+双字，如 纸/老虎
          finals[1] = finals[1].slice(0, -1) + '2'
        }
      } else {
        const finalsList = [finals.slice(0, wordList[0].length), finals.slice(wordList[0].length)]
        if (finalsList.length === 2) {
          for (let i = 0; i < finalsList.length; i++) {
            const sub = finalsList[i]
            if (this._allToneThree(sub) && sub.length === 2) {
              // 所有/人
              sub[0] = sub[0].slice(0, -1) + '2'
            } else if (
              i === 1 &&
              !this._allToneThree(sub) &&
              finalsList[i][0].endsWith('3') &&
              finalsList[0][finalsList[0].length - 1].endsWith('3')
            ) {
              // 好/喜欢
              const arr = finalsList[0]
              arr[arr.length - 1] = arr[arr.length - 1].slice(0, -1) + '2'
            }
          }
          finals = finalsList.flat()
        }
      }
    } else if (word.length === 4) {
      // 成语按两字分
      const finalsList = [finals.slice(0, 2), finals.slice(2)]
      finals = []
      for (const sub of finalsList) {
        if (this._allToneThree(sub)) {
          sub[0] = sub[0].slice(0, -1) + '2'
        }
        finals = finals.concat(sub)
      }
    }
    return finals
  }

  _allToneThree(finals) {
    if (!Array.isArray(finals)) console.log("[dbg] finals 非数组:", JSON.stringify(finals), typeof finals)
    return finals.every((x) => x.endsWith('3'))
  }

  // 合并「不」和后面的词：jieba 有时把「不」单独切出来导致变调错
  _mergeBu(seg) {
    const newSeg = []
    let lastWord = ''
    for (const [word, pos] of seg) {
      let w = word
      if (lastWord === '不') {
        w = lastWord + word
      }
      if (w !== '不') {
        newSeg.push([w, pos])
      }
      lastWord = w
    }
    if (lastWord === '不') {
      newSeg.push([lastWord, 'd'])
    }
    return newSeg
  }

  // 合并重叠动词里的一（听/一/听 → 听一听）；合并单「一」和后面的词
  _mergeYi(seg) {
    let newSeg = []
    for (let i = 0; i < seg.length; i++) {
      const [word, pos] = seg[i]
      if (
        i - 1 >= 0 &&
        word === '一' &&
        i + 1 < seg.length &&
        seg[i - 1][0] === seg[i + 1][0] &&
        seg[i - 1][1] === 'v'
      ) {
        newSeg[i - 1][0] = newSeg[i - 1][0] + '一' + newSeg[i - 1][0]
      } else {
        if (i - 2 >= 0 && seg[i - 1][0] === '一' && seg[i - 2][0] === word && pos === 'v') {
          continue
        }
        newSeg.push([word, pos])
      }
    }
    seg = newSeg
    newSeg = []
    for (let i = 0; i < seg.length; i++) {
      const [word, pos] = seg[i]
      if (newSeg.length && newSeg[newSeg.length - 1][0] === '一') {
        newSeg[newSeg.length - 1][0] = newSeg[newSeg.length - 1][0] + word
      } else {
        newSeg.push([word, pos])
      }
    }
    return newSeg
  }

  // 相邻两词全三声 → 合并
  _mergeContinuousThreeTones(seg) {
    const newSeg = []
    const subFinalsList = seg.map(([w]) => {
      const r = this.py(w)
      return r ? r.f.slice() : []
    })
    const mergeLast = new Array(seg.length).fill(false)
    for (let i = 0; i < seg.length; i++) {
      const [word, pos] = seg[i]
      if (
        i - 1 >= 0 &&
        this._allToneThree(subFinalsList[i - 1]) &&
        this._allToneThree(subFinalsList[i]) &&
        !mergeLast[i - 1]
      ) {
        // 叠词不合（交给轻声规则）
        if (
          !this._isReduplication(seg[i - 1][0]) &&
          seg[i - 1][0].length + seg[i][0].length <= 3
        ) {
          newSeg[newSeg.length - 1][0] = newSeg[newSeg.length - 1][0] + seg[i][0]
          mergeLast[i] = true
        } else {
          newSeg.push([word, pos])
        }
      } else {
        newSeg.push([word, pos])
      }
    }
    return newSeg
  }

  _isReduplication(word) {
    return word.length === 2 && word[0] === word[1]
  }

  // 前词末字三声 + 后词首字三声 → 合并
  _mergeContinuousThreeTones2(seg) {
    const newSeg = []
    const subFinalsList = seg.map(([w]) => {
      const r = this.py(w)
      return r ? r.f.slice() : []
    })
    const mergeLast = new Array(seg.length).fill(false)
    for (let i = 0; i < seg.length; i++) {
      const [word, pos] = seg[i]
      if (
        i - 1 >= 0 &&
        subFinalsList[i - 1][subFinalsList[i - 1].length - 1].endsWith('3') &&
        subFinalsList[i][0].endsWith('3') &&
        !mergeLast[i - 1]
      ) {
        if (
          !this._isReduplication(seg[i - 1][0]) &&
          seg[i - 1][0].length + seg[i][0].length <= 3
        ) {
          newSeg[newSeg.length - 1][0] = newSeg[newSeg.length - 1][0] + seg[i][0]
          mergeLast[i] = true
        } else {
          newSeg.push([word, pos])
        }
      } else {
        newSeg.push([word, pos])
      }
    }
    return newSeg
  }

  _mergeEr(seg) {
    const newSeg = []
    for (let i = 0; i < seg.length; i++) {
      const [word] = seg[i]
      if (i - 1 >= 0 && word === '儿' && seg[i - 1][0] !== '#') {
        newSeg[newSeg.length - 1][0] = newSeg[newSeg.length - 1][0] + seg[i][0]
      } else {
        newSeg.push([word, seg[i][1]])
      }
    }
    return newSeg
  }

  _mergeReduplication(seg) {
    const newSeg = []
    for (let i = 0; i < seg.length; i++) {
      const [word, pos] = seg[i]
      if (newSeg.length && word === newSeg[newSeg.length - 1][0]) {
        newSeg[newSeg.length - 1][0] = newSeg[newSeg.length - 1][0] + seg[i][0]
      } else {
        newSeg.push([word, pos])
      }
    }
    return newSeg
  }

  preMergeForModify(seg) {
    seg = this._mergeBu(seg)
    try {
      seg = this._mergeYi(seg)
    } catch {
      console.warn('_merge_yi failed')
    }
    seg = this._mergeReduplication(seg)
    seg = this._mergeContinuousThreeTones(seg)
    seg = this._mergeContinuousThreeTones2(seg)
    seg = this._mergeEr(seg)
    return seg
  }

  modifiedTone(word, pos, finals) {
    finals = this._buSandhi(word, finals.slice())
    finals = this._yiSandhi(word, finals)
    finals = this._neuralSandhi(word, pos, finals)
    finals = this._threeSandhi(word, finals)
    return finals
  }
}
