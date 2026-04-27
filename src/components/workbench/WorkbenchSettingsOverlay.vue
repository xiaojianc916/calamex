<template>
  <section class="workbench-settings-overlay" role="dialog" aria-label="设置">
    <aside class="workbench-settings-nav">
      <div class="workbench-settings-nav-scroll">
        <section
          v-for="group in filteredNavGroups"
          :key="group.label"
          class="workbench-settings-nav-group"
        >
          <p class="workbench-settings-nav-label">{{ group.label }}</p>

          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="workbench-settings-nav-item"
            :class="{ 'is-active': !isSearching && activeSection === item.id }"
            @click="selectSection(item.id)"
          >
            <component :is="item.icon" class="h-3.5 w-3.5" />
            <span>{{ item.title }}</span>
          </button>
        </section>
      </div>
    </aside>

    <div class="workbench-settings-main-shell">
      <header class="workbench-settings-main-top">
        <button
          type="button"
          class="workbench-settings-top-button"
          aria-label="返回工作台"
          @click="void requestClose()"
        >
          <ArrowLeft class="h-4 w-4" />
        </button>

        <label class="workbench-settings-search">
          <Search class="h-4 w-4 shrink-0" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            placeholder="搜索设置"
            autocomplete="off"
          />
        </label>

        <div class="workbench-settings-top-meta">
          <span v-if="isSearching" class="workbench-settings-result-count">
            {{ sectionIdsToRender.length }} 个分类结果
          </span>

          <span v-else-if="isDirty" class="workbench-settings-result-count">
            有未确认的设置变更
          </span>

          <button
            type="button"
            class="workbench-settings-top-button"
            aria-label="关闭设置"
            @click="void requestClose()"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </header>

      <main ref="scrollRef" class="workbench-settings-main-scroll">
        <div class="workbench-settings-main-inner">
          <template v-if="sectionIdsToRender.length > 0">
            <template v-for="sectionId in sectionIdsToRender" :key="sectionId">
              <section v-if="sectionId === 'general'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>常规</h1>
                  <p>语言、启动、更新与遥测等全局偏好。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">语言与区域</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">界面语言</div>
                      </div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.general.language"
                          @change="patchSection('general', { language: 'zh-CN' }, '界面语言已保存')"
                        >
                          <option value="zh-CN">简体中文</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">日期格式</div>
                      </div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.general.dateFormat"
                          @change="patchSection('general', { dateFormat: 'YYYY-MM-DD' }, '日期格式已保存')"
                        >
                          <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">使用 24 小时制</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.general.use24HourClock }"
                          :aria-pressed="appStore.settings.general.use24HourClock"
                          @click="toggleSetting('general', 'use24HourClock', '时间格式已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">启动</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">启动时打开</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="mode in startupOptions"
                            :key="mode.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.general.startupBehavior === mode.value }"
                            @click="patchSection('general', { startupBehavior: mode.value }, '启动方式已保存')"
                          >
                            {{ mode.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">最近文件数量</div>
                      </div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="5"
                          max="100"
                          :value="appStore.settings.general.recentFileLimit"
                          @change="handleNumberFieldChange('general', 'recentFileLimit', $event, 5, 100, '最近文件数量已保存')"
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">更新与隐私</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">自动检查更新</div>
                        <div class="desc">默认只检查，不自动安装。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.general.autoCheckUpdates }"
                          :aria-pressed="appStore.settings.general.autoCheckUpdates"
                          @click="toggleSetting('general', 'autoCheckUpdates', '更新策略已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">更新渠道</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="channel in updateChannelOptions"
                            :key="channel.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.general.updateChannel === channel.value }"
                            @click="patchSection('general', { updateChannel: channel.value }, '更新渠道已保存')"
                          >
                            {{ channel.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">匿名使用统计</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.general.telemetryEnabled }"
                          :aria-pressed="appStore.settings.general.telemetryEnabled"
                          @click="toggleSetting('general', 'telemetryEnabled', '隐私设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">崩溃报告</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.general.crashReportsEnabled }"
                          :aria-pressed="appStore.settings.general.crashReportsEnabled"
                          @click="toggleSetting('general', 'crashReportsEnabled', '隐私设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'appearance'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>外观</h1>
                  <p>主题、强调色、圆角和界面节奏。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">主题</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">主题模式</div>
                        <div class="desc">改动后立即作用于整个工作台。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="themeOption in themePreferenceOptions"
                            :key="themeOption.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.appearance.themePreference === themeOption.value }"
                            @click="patchSection('appearance', { themePreference: themeOption.value }, '主题偏好已保存')"
                          >
                            {{ themeOption.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">强调色</div>
                        <div class="desc">用于激活、选中、按钮和状态高亮。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-swatches">
                          <button
                            v-for="swatch in accentSwatches"
                            :key="swatch.value"
                            type="button"
                            class="swatch"
                            :class="{ 'is-active': appStore.settings.appearance.accentColor === swatch.value }"
                            :style="{ background: swatch.color }"
                            :aria-label="swatch.label"
                            @click="patchSection('appearance', { accentColor: swatch.value }, '强调色已保存')"
                          />
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">界面密度</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="density in densityOptions"
                            :key="density.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.appearance.uiDensity === density.value }"
                            @click="patchSection('appearance', { uiDensity: density.value }, '界面密度已保存')"
                          >
                            {{ density.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">界面字号</div>
                      </div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="12"
                          max="16"
                          :value="appStore.settings.appearance.interfaceFontSize"
                          @change="handleNumberFieldChange('appearance', 'interfaceFontSize', $event, 12, 16, '界面字号已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">圆角</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="radius in radiusOptions"
                            :key="radius.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.appearance.radiusPreset === radius.value }"
                            @click="patchSection('appearance', { radiusPreset: radius.value }, '圆角设置已保存')"
                          >
                            {{ radius.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">减少动画</div>
                        <div class="desc">关闭设置页和工作台中的大部分过渡。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.appearance.reduceMotion }"
                          :aria-pressed="appStore.settings.appearance.reduceMotion"
                          @click="toggleSetting('appearance', 'reduceMotion', '动画设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'editor'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>编辑器</h1>
                  <p>控制脚本编辑器的字体、保存与显示行为。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">字体与排版</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">字体</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-text-input"
                          type="text"
                          :value="appStore.settings.editor.fontFamily"
                          @change="handleTextFieldChange('editor', 'fontFamily', $event, '编辑器字体已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">字号</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="11"
                          max="20"
                          :value="appStore.settings.editor.fontSize"
                          @change="handleNumberFieldChange('editor', 'fontSize', $event, 11, 20, '编辑器字号已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">行高</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.editor.lineHeight"
                          @change="handleSelectFieldChange('editor', 'lineHeight', $event, '编辑器行高已保存')"
                        >
                          <option value="1.4">1.4 倍</option>
                          <option value="1.6">1.6 倍</option>
                          <option value="1.8">1.8 倍</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">启用字体连字</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.editor.fontLigatures }"
                          :aria-pressed="appStore.settings.editor.fontLigatures"
                          @click="toggleSetting('editor', 'fontLigatures', '编辑器字体设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">缩进</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">缩进风格</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="indentation in indentationOptions"
                            :key="indentation.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.editor.indentation === indentation.value }"
                            @click="patchSection('editor', { indentation: indentation.value }, '缩进设置已保存')"
                          >
                            {{ indentation.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">Tab 大小</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="2"
                          max="8"
                          :value="appStore.settings.editor.tabSize"
                          @change="handleNumberFieldChange('editor', 'tabSize', $event, 2, 8, '缩进设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">根据文件自动检测</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.editor.detectIndentation }"
                          :aria-pressed="appStore.settings.editor.detectIndentation"
                          @click="toggleSetting('editor', 'detectIndentation', '缩进设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">编辑行为</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">自动保存</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.editor.autoSave"
                          @change="handleSelectFieldChange('editor', 'autoSave', $event, '自动保存策略已保存')"
                        >
                          <option value="off">关闭</option>
                          <option value="focus">失去焦点时</option>
                        </select>
                      </div>
                    </div>

                    <div
                      v-for="item in editorBehaviorToggleItems"
                      :key="item.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label">
                        <div class="title">{{ item.title }}</div>
                        <div v-if="item.description" class="desc">{{ item.description }}</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.editor[item.key] }"
                          :aria-pressed="appStore.settings.editor[item.key]"
                          @click="toggleSetting('editor', item.key, '编辑器行为已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">显示与补全</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">自动换行</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.editor.wordWrap"
                          @change="handleSelectFieldChange('editor', 'wordWrap', $event, '显示设置已保存')"
                        >
                          <option value="off">关闭</option>
                          <option value="viewport">按视口宽度</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">显示空白字符</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="whitespace in whitespaceOptions"
                            :key="whitespace.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.editor.whitespace === whitespace.value }"
                            @click="patchSection('editor', { whitespace: whitespace.value }, '显示设置已保存')"
                          >
                            {{ whitespace.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div
                      v-for="item in editorDisplayToggleItems"
                      :key="item.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label"><div class="title">{{ item.title }}</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.editor[item.key] }"
                          :aria-pressed="appStore.settings.editor[item.key]"
                          @click="toggleSetting('editor', item.key, '显示设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">补全触发字符</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="editorCompletionTriggersText"
                          @change="handleCsvFieldChange('editor', 'completionTriggers', $event, '补全触发字符已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">建议延迟</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="0"
                          max="2000"
                          :value="appStore.settings.editor.suggestionDelay"
                          @change="handleNumberFieldChange('editor', 'suggestionDelay', $event, 0, 2000, '补全延迟已保存')"
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">新建脚本</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认 shebang</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="appStore.settings.editor.defaultShebang"
                          @change="handleTextFieldChange('editor', 'defaultShebang', $event, '默认脚本模板已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认严格模式</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.editor.strictModeByDefault }"
                          :aria-pressed="appStore.settings.editor.strictModeByDefault"
                          @click="toggleSetting('editor', 'strictModeByDefault', '默认脚本模板已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">重置编辑器设置</div>
                        <div class="desc">仅恢复本分类，不影响其他设置。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-button"
                          @click="resetSection('editor', '编辑器设置已恢复默认')"
                        >
                          重置为默认
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'terminal'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>终端</h1>
                  <p>内建 WSL2 终端的 shell、外观与交互行为。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">Shell</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认 shell</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="appStore.settings.terminal.defaultShell"
                          @change="handleTextFieldChange('terminal', 'defaultShell', $event, '终端 shell 已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">启动参数</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="appStore.settings.terminal.shellArgs"
                          @change="handleTextFieldChange('terminal', 'shellArgs', $event, '终端 shell 已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认工作目录</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.terminal.workingDirectory"
                          @change="handleSelectFieldChange('terminal', 'workingDirectory', $event, '终端目录策略已保存')"
                        >
                          <option value="current-file">跟随当前文件</option>
                          <option value="workspace-root">工作区根目录</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">继承环境变量</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.terminal.inheritEnvironment }"
                          :aria-pressed="appStore.settings.terminal.inheritEnvironment"
                          @click="toggleSetting('terminal', 'inheritEnvironment', '终端目录策略已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">外观与交互</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">字体</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-text-input"
                          type="text"
                          :value="appStore.settings.terminal.fontFamily"
                          @change="handleTextFieldChange('terminal', 'fontFamily', $event, '终端字体已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">字号</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="11"
                          max="20"
                          :value="appStore.settings.terminal.fontSize"
                          @change="handleNumberFieldChange('terminal', 'fontSize', $event, 11, 20, '终端字体已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">行高</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.terminal.lineHeight"
                          @change="handleSelectFieldChange('terminal', 'lineHeight', $event, '终端外观已保存')"
                        >
                          <option value="1.2">1.2 倍</option>
                          <option value="1.4">1.4 倍</option>
                          <option value="1.6">1.6 倍</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">光标样式</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="cursorStyle in cursorStyleOptions"
                            :key="cursorStyle.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.terminal.cursorStyle === cursorStyle.value }"
                            @click="patchSection('terminal', { cursorStyle: cursorStyle.value }, '终端外观已保存')"
                          >
                            {{ cursorStyle.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div
                      v-for="item in terminalToggleItems"
                      :key="item.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label">
                        <div class="title">{{ item.title }}</div>
                        <div v-if="item.description" class="desc">{{ item.description }}</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.terminal[item.key] }"
                          :aria-pressed="appStore.settings.terminal[item.key]"
                          @click="toggleSetting('terminal', item.key, '终端交互设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">回看缓冲区</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="1000"
                          max="20000"
                          step="500"
                          :value="appStore.settings.terminal.scrollback"
                          @change="handleNumberFieldChange('terminal', 'scrollback', $event, 1000, 20000, '终端交互设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">右键菜单</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="behavior in rightClickOptions"
                            :key="behavior.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.terminal.rightClickBehavior === behavior.value }"
                            @click="patchSection('terminal', { rightClickBehavior: behavior.value }, '终端交互设置已保存')"
                          >
                            {{ behavior.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">响铃方式</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="bell in bellOptions"
                            :key="bell.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.terminal.bellMode === bell.value }"
                            @click="patchSection('terminal', { bellMode: bell.value }, '终端交互设置已保存')"
                          >
                            {{ bell.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">重置终端设置</div>
                        <div class="desc">保活逻辑不受影响，只恢复界面与行为偏好。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-button"
                          @click="resetSection('terminal', '终端设置已恢复默认')"
                        >
                          重置为默认
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'run'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>运行与调试</h1>
                  <p>脚本执行时的默认解释器、工作目录与运行后反馈。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">运行</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认解释器</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="appStore.settings.run.defaultInterpreter"
                          @change="handleTextFieldChange('run', 'defaultInterpreter', $event, '运行设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">工作目录</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.run.workingDirectory"
                          @change="handleSelectFieldChange('run', 'workingDirectory', $event, '运行设置已保存')"
                        >
                          <option value="script-dir">脚本所在目录</option>
                          <option value="workspace-root">工作区根目录</option>
                        </select>
                      </div>
                    </div>

                    <div
                      v-for="item in runToggleItems"
                      :key="item.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label">
                        <div class="title">{{ item.title }}</div>
                        <div v-if="item.description" class="desc">{{ item.description }}</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.run[item.key] }"
                          :aria-pressed="appStore.settings.run[item.key]"
                          @click="toggleSetting('run', item.key, '运行设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">停止超时</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="1"
                          max="30"
                          :value="appStore.settings.run.stopTimeoutSeconds"
                          @change="handleNumberFieldChange('run', 'stopTimeoutSeconds', $event, 1, 30, '运行设置已保存')"
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">环境变量</div>
                  <div class="workbench-settings-list-card">
                    <div class="workbench-settings-list-head env-grid">
                      <span>键</span>
                      <span>值</span>
                      <span class="cell-action">操作</span>
                    </div>

                    <div
                      v-for="envItem in runEnvironmentVariables"
                      :key="envItem.id"
                      class="workbench-settings-list-row env-grid"
                    >
                      <input
                        class="workbench-settings-text-input is-mono"
                        type="text"
                        :value="envItem.key"
                        @change="handleEnvironmentVariableChange(envItem.id, 'key', $event)"
                      />
                      <input
                        class="workbench-settings-text-input is-mono"
                        type="text"
                        :value="envItem.value"
                        @change="handleEnvironmentVariableChange(envItem.id, 'value', $event)"
                      />
                      <button
                        type="button"
                        class="workbench-settings-icon-button"
                        aria-label="删除环境变量"
                        @click="removeEnvironmentVariable(envItem.id)"
                      >
                        <Trash2 class="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div class="workbench-settings-list-footer">
                      <button
                        type="button"
                        class="workbench-settings-button"
                        @click="addEnvironmentVariable"
                      >
                        <Plus class="h-3.5 w-3.5" />
                        <span>添加环境变量</span>
                      </button>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">完成后</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">保留已结束的终端</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="1"
                          max="20"
                          :value="appStore.settings.run.preservedTerminalCount"
                          @change="handleNumberFieldChange('run', 'preservedTerminalCount', $event, 1, 20, '运行设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">重置运行设置</div>
                        <div class="desc">不会影响当前已经在运行的终端任务。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-button"
                          @click="resetSection('run', '运行设置已恢复默认')"
                        >
                          重置为默认
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'style'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>代码风格</h1>
                  <p>控制 shfmt 与 ShellCheck 的默认策略。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">shfmt 格式化</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">启用 shfmt</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.style.enableShfmt }"
                          :aria-pressed="appStore.settings.style.enableShfmt"
                          @click="toggleSetting('style', 'enableShfmt', '格式化设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">缩进大小</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="2"
                          max="8"
                          :value="appStore.settings.style.shfmtIndentSize"
                          @change="handleNumberFieldChange('style', 'shfmtIndentSize', $event, 2, 8, '格式化设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">函数左花括号位置</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented">
                          <button
                            v-for="brace in braceStyleOptions"
                            :key="brace.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.style.functionBraceStyle === brace.value }"
                            @click="patchSection('style', { functionBraceStyle: brace.value }, '格式化设置已保存')"
                          >
                            {{ brace.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div
                      v-for="item in styleToggleItems"
                      :key="item.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label">
                        <div class="title">{{ item.title }}</div>
                        <div v-if="item.description" class="desc">{{ item.description }}</div>
                      </div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.style[item.key] }"
                          :aria-pressed="appStore.settings.style[item.key]"
                          @click="toggleSetting('style', item.key, '格式化设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">语言变体</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.style.languageVariant"
                          @change="handleSelectFieldChange('style', 'languageVariant', $event, '格式化设置已保存')"
                        >
                          <option value="bash">bash</option>
                          <option value="posix">posix</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">ShellCheck</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">启用 ShellCheck</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.style.enableShellcheck }"
                          :aria-pressed="appStore.settings.style.enableShellcheck"
                          @click="toggleSetting('style', 'enableShellcheck', 'ShellCheck 设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">最低诊断级别</div></div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-segmented is-wide">
                          <button
                            v-for="level in diagnosticLevelOptions"
                            :key="level.value"
                            type="button"
                            class="segment"
                            :class="{ 'is-active': appStore.settings.style.minimumDiagnosticLevel === level.value }"
                            @click="patchSection('style', { minimumDiagnosticLevel: level.value }, 'ShellCheck 设置已保存')"
                          >
                            {{ level.label }}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认 shell</div></div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.style.shellDialect"
                          @change="handleSelectFieldChange('style', 'shellDialect', $event, 'ShellCheck 设置已保存')"
                        >
                          <option value="bash">bash</option>
                          <option value="sh">sh</option>
                          <option value="ksh">ksh</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">忽略规则</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="styleIgnoredRulesText"
                          @change="handleCsvFieldChange('style', 'ignoredRules', $event, 'ShellCheck 设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">显示行宽参考线</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="60"
                          max="240"
                          :value="appStore.settings.style.rulerColumn"
                          @change="handleNumberFieldChange('style', 'rulerColumn', $event, 60, 240, '行宽设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">重置代码风格设置</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-button"
                          @click="resetSection('style', '代码风格设置已恢复默认')"
                        >
                          重置为默认
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'keybinds'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>快捷键</h1>
                  <p>查看常用命令的默认键位，并统一键位布局预设。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">命令</div>
                  <div class="workbench-settings-list-card">
                    <div class="workbench-settings-list-head keybind-grid">
                      <span>命令</span>
                      <span>快捷键</span>
                      <span>作用域</span>
                    </div>

                    <div
                      v-for="item in filteredKeybindingItems"
                      :key="item.command"
                      class="workbench-settings-list-row keybind-grid"
                    >
                      <div>
                        <div class="workbench-settings-list-title">{{ item.title }}</div>
                        <div class="workbench-settings-list-subtitle">{{ item.command }}</div>
                      </div>
                      <div class="workbench-settings-kbd-group">
                        <span v-for="key in item.keys" :key="key" class="kbd">{{ key }}</span>
                      </div>
                      <div class="workbench-settings-list-muted">{{ item.scope }}</div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">全局</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">键位布局</div>
                        <div class="desc">用于描述展示用的修饰键，而不是修改系统级快捷键。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <select
                          class="workbench-settings-select"
                          :value="appStore.settings.keybinds.keyboardLayoutPreset"
                          @change="handleSelectFieldChange('keybinds', 'keyboardLayoutPreset', $event, '键位布局已保存')"
                        >
                          <option value="windows">Windows / Linux</option>
                          <option value="macos">macOS</option>
                        </select>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">打开设置快捷键</div>
                        <div class="desc">当前工作台支持 Esc 关闭，和 {{ primaryModifierLabel }} + , 开关设置页。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <div class="workbench-settings-kbd-group">
                          <span class="kbd">{{ primaryModifierLabel }}</span>
                          <span class="kbd">,</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'integrations'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>集成</h1>
                  <p>Git 与 SSH 的常用偏好，统一集中在前端配置中。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">Git</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">启用 Git 集成</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.integrations.gitEnabled }"
                          :aria-pressed="appStore.settings.integrations.gitEnabled"
                          @click="toggleSetting('integrations', 'gitEnabled', 'Git 设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div
                      v-for="field in gitTextFields"
                      :key="field.key"
                      class="workbench-settings-row"
                    >
                      <div class="workbench-settings-label"><div class="title">{{ field.title }}</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input"
                          type="text"
                          :value="appStore.settings.integrations[field.key]"
                          @change="handleTextFieldChange('integrations', field.key, $event, 'Git 设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">自动获取</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.integrations.gitAutoFetch }"
                          :aria-pressed="appStore.settings.integrations.gitAutoFetch"
                          @click="toggleSetting('integrations', 'gitAutoFetch', 'Git 设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">签名提交</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.integrations.gitSignedCommit }"
                          :aria-pressed="appStore.settings.integrations.gitSignedCommit"
                          @click="toggleSetting('integrations', 'gitSignedCommit', 'Git 设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">SSH</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">默认私钥路径</div></div>
                      <div class="workbench-settings-control control-grow">
                        <input
                          class="workbench-settings-text-input is-mono"
                          type="text"
                          :value="appStore.settings.integrations.sshIdentityPath"
                          @change="handleTextFieldChange('integrations', 'sshIdentityPath', $event, 'SSH 设置已保存')"
                        />
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">使用 ssh-agent</div></div>
                      <div class="workbench-settings-control">
                        <button
                          type="button"
                          class="workbench-settings-switch"
                          :class="{ 'is-on': appStore.settings.integrations.sshUseAgent }"
                          :aria-pressed="appStore.settings.integrations.sshUseAgent"
                          @click="toggleSetting('integrations', 'sshUseAgent', 'SSH 设置已保存')"
                        >
                          <span />
                        </button>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label"><div class="title">连接超时</div></div>
                      <div class="workbench-settings-control">
                        <input
                          class="workbench-settings-number"
                          type="number"
                          min="3"
                          max="60"
                          :value="appStore.settings.integrations.sshConnectTimeoutSeconds"
                          @change="handleNumberFieldChange('integrations', 'sshConnectTimeoutSeconds', $event, 3, 60, 'SSH 设置已保存')"
                        />
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'ai'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>AI</h1>
                  <p>配置通用 IDE AI、内联补全和受控 Agent。API Key 只写入系统凭证存储。</p>
                </header>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">Provider</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">当前模型</div>
                        <div class="desc">
                          {{ aiConfig.providerType }} · {{ aiConfig.selectedModel ?? '未选择模型' }}
                        </div>
                      </div>
                      <div class="workbench-settings-control">
                        <span class="workbench-settings-pill" :class="{ 'is-success': aiConfig.isConfigured }">
                          {{ aiConfig.isConfigured ? '已配置' : '未完成' }}
                        </span>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">能力开关</div>
                        <div class="desc">
                          Chat {{ aiConfig.chatEnabled ? '开启' : '关闭' }} · Inline {{ aiConfig.inlineCompletionEnabled ? '开启' : '关闭' }} · Agent {{ aiConfig.agentEnabled ? '开启' : '关闭' }}
                        </div>
                      </div>
                      <div class="workbench-settings-control">
                        <button type="button" class="workbench-settings-button" @click="openAiSettingsDialog">
                          <Settings2 class="h-3.5 w-3.5" />
                          <span>配置 AI</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </section>

              <section v-else-if="sectionId === 'about'" class="workbench-settings-page">
                <header class="workbench-settings-page-head">
                  <h1>关于</h1>
                  <p>版本、当前主题解析结果和本地设置持久化方式。</p>
                </header>

                <section class="workbench-settings-about-hero">
                  <div class="logo">sh</div>
                  <div>
                    <div class="name">sh-editor-desktop</div>
                    <div class="meta">v0.1.0 · {{ resolvedThemeLabel }} · 本地持久化已启用</div>
                  </div>
                  <div class="spacer" />
                  <button type="button" class="workbench-settings-button" @click="copyVersionInfo">
                    <Copy class="h-3.5 w-3.5" />
                    <span>复制版本信息</span>
                  </button>
                </section>

                <section class="workbench-settings-block">
                  <div class="workbench-settings-block-title">诊断</div>
                  <div class="workbench-settings-rows">
                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">主题解析结果</div>
                        <div class="desc">当前实际应用到编辑器、终端与工作台的是 {{ resolvedThemeLabel }}。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <span class="workbench-settings-pill">{{ resolvedThemeLabel }}</span>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">设置持久化</div>
                        <div class="desc">当前版本使用前端本地存储保留用户设置，不会触碰 tauri.conf.json。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <span class="workbench-settings-pill is-muted">localStorage</span>
                      </div>
                    </div>

                    <div class="workbench-settings-row">
                      <div class="workbench-settings-label">
                        <div class="title">设置覆盖层</div>
                        <div class="desc">设置页通过根布局覆盖内容区实现，工作台路由与终端会话保持不变。</div>
                      </div>
                      <div class="workbench-settings-control">
                        <span class="workbench-settings-pill is-success">保活中</span>
                      </div>
                    </div>
                  </div>
                </section>
              </section>
            </template>
          </template>

          <div v-else class="workbench-settings-empty-state">
            <div class="title">没有找到匹配的设置</div>
            <p>可以尝试搜索“主题”、“终端”或“快捷键”。</p>
          </div>
        </div>
      </main>
    </div>

    <AiProviderSettings
      v-model:draft="aiSettingsDraft"
      v-model:api-key="aiSettingsApiKey"
      :open="isAiSettingsOpen"
      :config="aiConfig"
      @close="isAiSettingsOpen = false"
      @save="saveAiSettings"
      @save-credentials="saveAiCredentials"
      @test-provider="testAiProvider"
    />
  </section>
</template>

<script setup lang="ts">
import { useDialog } from '@/composables/useDialog';
import AiProviderSettings from '@/components/business/ai/AiProviderSettings.vue';
import { aiService } from '@/services/modules/ai';
import { useAppStore } from '@/store/app';
import type { IAiConfigPayload } from '@/types/ai';
import { tryWriteClipboardText } from '@/utils/clipboard';
import {
    createSettingsEnvironmentVariable,
    type IAppSettings,
    type TAppSettingsSectionKey,
    type TSettingsSectionId,
} from '@/types/settings';
import {
    ArrowLeft,
    CircleHelp,
    Copy,
    FileCode2,
    Keyboard,
    ListChecks,
    Palette,
    Play,
    Plus,
    Search,
    Settings2,
    TerminalSquare,
    Trash2,
    Waypoints,
    Bot,
    X,
} from 'lucide-vue-next';
import { computed, nextTick, ref, watch, type Component } from 'vue';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  saved: [message: string];
}>();

type TNavItem = {
  id: TSettingsSectionId;
  title: string;
  icon: Component;
  searchTerms: string[];
};

type TNavGroup = {
  label: string;
  items: TNavItem[];
};

type TBooleanKeys<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

const NAV_GROUPS: TNavGroup[] = [
  {
    label: '工作区',
    items: [
      {
        id: 'general',
        title: '常规',
        icon: Settings2,
        searchTerms: ['常规', '语言', '启动', '更新', '隐私', '时间', '遥测'],
      },
      {
        id: 'appearance',
        title: '外观',
        icon: Palette,
        searchTerms: ['外观', '主题', '强调色', '圆角', '密度', '动画', '颜色'],
      },
    ],
  },
  {
    label: '编辑',
    items: [
      {
        id: 'editor',
        title: '编辑器',
        icon: FileCode2,
        searchTerms: ['编辑器', '字体', '缩进', '补全', 'shebang', '保存', '换行'],
      },
      {
        id: 'terminal',
        title: '终端',
        icon: TerminalSquare,
        searchTerms: ['终端', 'shell', '光标', '滚动', '复制', '右键', '响铃'],
      },
      {
        id: 'run',
        title: '运行与调试',
        icon: Play,
        searchTerms: ['运行', '解释器', '调试', '环境变量', '超时', '通知'],
      },
      {
        id: 'style',
        title: '代码风格',
        icon: ListChecks,
        searchTerms: ['风格', 'shfmt', 'shellcheck', '规则', '列宽', '诊断'],
      },
    ],
  },
  {
    label: '其它',
    items: [
      {
        id: 'keybinds',
        title: '快捷键',
        icon: Keyboard,
        searchTerms: ['快捷键', '按键', 'command palette', 'ctrl+,', 'cmd+,', '终端切换'],
      },
      {
        id: 'integrations',
        title: '集成',
        icon: Waypoints,
        searchTerms: ['集成', 'git', 'ssh', '邮箱', '分支', '密钥'],
      },
      {
        id: 'ai',
        title: 'AI',
        icon: Bot,
        searchTerms: ['AI', '模型', 'Provider', 'OpenAI', '补全', 'Agent', 'API Key'],
      },
      {
        id: 'about',
        title: '关于',
        icon: CircleHelp,
        searchTerms: ['关于', '版本', '诊断', '持久化', 'localStorage'],
      },
    ],
  },
];

const KEYBINDING_ITEMS = [
  {
    title: '打开命令面板',
    command: 'workbench.action.commandPalette',
    keys: ['Ctrl', 'Shift', 'P'],
    scope: '全局',
  },
  {
    title: '全局搜索',
    command: 'workbench.action.findInFiles',
    keys: ['Ctrl', 'Shift', 'F'],
    scope: '全局',
  },
  {
    title: '运行当前脚本',
    command: 'sh.run.current',
    keys: ['Ctrl', 'R'],
    scope: '编辑器',
  },
  {
    title: '切换终端',
    command: 'workbench.action.terminal.toggle',
    keys: ['Ctrl', '`'],
    scope: '全局',
  },
  {
    title: '打开设置',
    command: 'workbench.action.openSettingsOverlay',
    keys: ['Ctrl', ','],
    scope: '全局',
  },
] as const;

const startupOptions = [
  { value: 'restore', label: '上次会话' },
  { value: 'empty', label: '空工作台' },
] as const;

const updateChannelOptions = [
  { value: 'stable', label: '稳定版' },
  { value: 'beta', label: 'Beta' },
  { value: 'nightly', label: 'Nightly' },
] as const;

const themePreferenceOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

const densityOptions = [
  { value: 'compact', label: '紧凑' },
  { value: 'default', label: '标准' },
  { value: 'comfortable', label: '舒适' },
] as const;

const radiusOptions = [
  { value: 'sharp', label: '锐利' },
  { value: 'default', label: '默认' },
  { value: 'rounded', label: '圆润' },
] as const;

const indentationOptions = [
  { value: 'spaces', label: '空格' },
  { value: 'tabs', label: 'Tab' },
] as const;

const whitespaceOptions = [
  { value: 'never', label: '从不' },
  { value: 'selection', label: '选中时' },
  { value: 'always', label: '总是' },
] as const;

const cursorStyleOptions = [
  { value: 'block', label: '方块' },
  { value: 'underline', label: '下划线' },
  { value: 'bar', label: '竖线' },
] as const;

const rightClickOptions = [
  { value: 'paste', label: '粘贴' },
  { value: 'menu', label: '菜单' },
  { value: 'copy-paste', label: '复制粘贴' },
] as const;

const bellOptions = [
  { value: 'off', label: '关闭' },
  { value: 'flash', label: '闪烁' },
  { value: 'sound', label: '声音' },
] as const;

const braceStyleOptions = [
  { value: 'same-line', label: '同行' },
  { value: 'next-line', label: '下一行' },
] as const;

const diagnosticLevelOptions = [
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
  { value: 'style', label: '风格' },
] as const;

const accentSwatches = [
  { value: 'indigo', label: '靛蓝', color: '#5e6ad2' },
  { value: 'violet', label: '紫色', color: '#7c3aed' },
  { value: 'blue', label: '蓝色', color: '#2f80ed' },
  { value: 'teal', label: '青绿色', color: '#14b8a6' },
  { value: 'gold', label: '金色', color: '#e5b800' },
  { value: 'red', label: '红色', color: '#e5484d' },
] as const;

const editorBehaviorToggleItems = [
  { key: 'formatOnSave', title: '保存时格式化' },
  { key: 'shellcheckOnSave', title: '保存时运行 ShellCheck' },
  { key: 'autoClosingPairs', title: '自动闭合引号与括号' },
  { key: 'trimTrailingWhitespace', title: '删除行尾空格' },
  { key: 'insertFinalNewline', title: '文件末尾保留空行' },
] as const;

const editorDisplayToggleItems = [
  { key: 'lineNumbers', title: '显示行号' },
  { key: 'indentGuides', title: '显示缩进参考线' },
  { key: 'minimap', title: '显示 minimap' },
  { key: 'commandCompletion', title: '启用命令补全' },
] as const;

const terminalToggleItems = [
  { key: 'cursorBlink', title: '光标闪烁' },
  { key: 'trimFinalNewlineOnCopy', title: '复制时去除末尾换行' },
  { key: 'copyOnSelect', title: '选中时复制' },
  { key: 'clickableLinks', title: '可点击链接' },
] as const;

const runToggleItems = [
  { key: 'saveBeforeRun', title: '运行前自动保存' },
  { key: 'clearTerminalBeforeRun', title: '运行前清空终端' },
  { key: 'revealTerminalOnRun', title: '运行时显示终端' },
  { key: 'notifyOnFinish', title: '运行结束时发送通知' },
  { key: 'highlightNonZeroExit', title: '非零退出码时高亮' },
] as const;

const styleToggleItems = [
  { key: 'binaryOperatorLineBreak', title: '二进制运算符前换行' },
  { key: 'caseIndent', title: 'case 语句缩进' },
  { key: 'simplifyCase', title: 'switch case 简化' },
  { key: 'autoFix', title: '自动修复 ShellCheck 建议' },
] as const;

const gitTextFields = [
  { key: 'gitUserName', title: '用户名' },
  { key: 'gitUserEmail', title: '邮箱' },
  { key: 'gitDefaultBranch', title: '默认分支' },
] as const;

const appStore = useAppStore();
const { confirm } = useDialog();
const aiConfig = ref<IAiConfigPayload>({
  providerType: 'mock',
  selectedModel: 'mock-ide-assistant',
  baseUrl: null,
  isBaseUrlConfigured: true,
  hasCredentials: true,
  isConfigured: true,
  inlineCompletionEnabled: false,
  chatEnabled: true,
  agentEnabled: false,
});
const aiSettingsDraft = ref<IAiConfigPayload>({ ...aiConfig.value });
const aiSettingsApiKey = ref('');
const isAiSettingsOpen = ref(false);
const searchQuery = ref('');
const activeSection = ref<TSettingsSectionId>('editor');
const searchInputRef = ref<HTMLInputElement | null>(null);
const scrollRef = ref<HTMLElement | null>(null);
const initialSettingsSnapshot = ref<IAppSettings>(cloneSettings(appStore.settings));
let pendingCloseRequest: Promise<boolean> | null = null;

function cloneSettings(value: IAppSettings): IAppSettings {
  return JSON.parse(JSON.stringify(value)) as IAppSettings;
}

const serializeSettings = (value: IAppSettings): string => JSON.stringify(value);

const toSafeArray = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);

const syncInitialSettingsSnapshot = (): void => {
  initialSettingsSnapshot.value = cloneSettings(appStore.settings);
};

const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
const isSearching = computed(() => normalizedSearchQuery.value.length > 0);
const isDirty = computed(
  () => serializeSettings(appStore.settings) !== serializeSettings(initialSettingsSnapshot.value),
);
const primaryModifierLabel = computed(() =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl',
);
const resolvedThemeLabel = computed(() =>
  appStore.theme === 'dark' ? '深色主题' : '浅色主题',
);
const editorCompletionTriggersText = computed(() =>
  toSafeArray(appStore.settings.editor.completionTriggers).join(', '),
);
const styleIgnoredRulesText = computed(() =>
  toSafeArray(appStore.settings.style.ignoredRules).join(', '),
);
const runEnvironmentVariables = computed(() =>
  toSafeArray(appStore.settings.run.environmentVariables),
);

const matchesSectionSearch = (item: TNavItem): boolean => {
  if (!normalizedSearchQuery.value) {
    return true;
  }

  return item.searchTerms.some((term) => term.toLowerCase().includes(normalizedSearchQuery.value));
};

const filteredNavGroups = computed(() =>
  NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => matchesSectionSearch(item)),
  })).filter((group) => group.items.length > 0),
);

const sectionIdsToRender = computed<TSettingsSectionId[]>(() => {
  if (!isSearching.value) {
    return [activeSection.value];
  }

  return filteredNavGroups.value.flatMap((group) => group.items.map((item) => item.id));
});

const filteredKeybindingItems = computed(() => {
  if (!isSearching.value) {
    return KEYBINDING_ITEMS;
  }

  return KEYBINDING_ITEMS.filter((item) => {
    const haystack = `${item.title} ${item.command} ${item.scope} ${item.keys.join(' ')}`.toLowerCase();
    return haystack.includes(normalizedSearchQuery.value);
  });
});

const emitSaved = (message: string): void => {
  emit('saved', message);
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

const scrollToTop = (): void => {
  nextTick(() => {
    scrollRef.value?.scrollTo({ top: 0, behavior: 'auto' });
  });
};

const selectSection = (sectionId: TSettingsSectionId): void => {
  activeSection.value = sectionId;
  scrollToTop();
};

const patchSection = <S extends TAppSettingsSectionKey>(
  section: S,
  patch: Partial<IAppSettings[S]>,
  message: string,
): void => {
  Object.assign(appStore.settings[section], patch);
  emitSaved(message);
};

const toggleSetting = <S extends TAppSettingsSectionKey>(
  section: S,
  key: TBooleanKeys<IAppSettings[S]>,
  message: string,
): void => {
  patchSection(section, {
    [key]: !appStore.settings[section][key],
  } as Partial<IAppSettings[S]>, message);
};

const handleTextFieldChange = <S extends TAppSettingsSectionKey, K extends keyof IAppSettings[S]>(
  section: S,
  key: K,
  event: Event,
  message: string,
): void => {
  const target = event.target as HTMLInputElement;
  patchSection(section, { [key]: target.value.trim() } as Partial<IAppSettings[S]>, message);
};

const handleSelectFieldChange = <S extends TAppSettingsSectionKey, K extends keyof IAppSettings[S]>(
  section: S,
  key: K,
  event: Event,
  message: string,
): void => {
  const target = event.target as HTMLSelectElement;
  patchSection(section, { [key]: target.value } as Partial<IAppSettings[S]>, message);
};

const handleNumberFieldChange = <S extends TAppSettingsSectionKey, K extends keyof IAppSettings[S]>(
  section: S,
  key: K,
  event: Event,
  min: number,
  max: number,
  message: string,
): void => {
  const target = event.target as HTMLInputElement;
  const parsedValue = Number(target.value);
  const nextValue = Number.isFinite(parsedValue)
    ? clampNumber(parsedValue, min, max)
    : clampNumber(Number(appStore.settings[section][key]), min, max);

  target.value = String(nextValue);
  patchSection(section, { [key]: nextValue } as Partial<IAppSettings[S]>, message);
};

const handleCsvFieldChange = <S extends TAppSettingsSectionKey, K extends keyof IAppSettings[S]>(
  section: S,
  key: K,
  event: Event,
  message: string,
): void => {
  const target = event.target as HTMLInputElement;
  const values = target.value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  target.value = values.join(', ');
  patchSection(section, { [key]: values } as Partial<IAppSettings[S]>, message);
};

const addEnvironmentVariable = (): void => {
  appStore.settings.run.environmentVariables = [
    ...runEnvironmentVariables.value,
    createSettingsEnvironmentVariable(),
  ];
  emitSaved('环境变量已添加');
};

const removeEnvironmentVariable = (id: string): void => {
  appStore.settings.run.environmentVariables = runEnvironmentVariables.value.filter(
    (item) => item.id !== id,
  );
  emitSaved('环境变量已删除');
};

const handleEnvironmentVariableChange = (
  id: string,
  key: 'key' | 'value',
  event: Event,
): void => {
  const target = event.target as HTMLInputElement;
  appStore.settings.run.environmentVariables = runEnvironmentVariables.value.map((item) =>
    item.id === id
      ? {
        ...item,
        [key]: target.value.trim(),
      }
      : item,
  );
  emitSaved('环境变量已保存');
};

const resetSection = (section: TAppSettingsSectionKey, message: string): void => {
  appStore.resetSettingsSection(section);
  emitSaved(message);
};

const copyVersionInfo = async (): Promise<void> => {
  const payload = `sh-editor-desktop v0.1.0 (${resolvedThemeLabel.value})`;
  const copied = await tryWriteClipboardText(payload);
  emitSaved(copied ? '版本信息已复制' : '当前环境不支持剪贴板写入');
};

const loadAiConfig = async (): Promise<void> => {
  aiConfig.value = await aiService.getConfig();
  aiSettingsDraft.value = { ...aiConfig.value };
};

const openAiSettingsDialog = async (): Promise<void> => {
  await loadAiConfig();
  isAiSettingsOpen.value = true;
};

const saveAiSettings = async (config: IAiConfigPayload): Promise<void> => {
  aiConfig.value = await aiService.saveConfig({
    providerType: config.providerType,
    selectedModel: config.selectedModel,
    baseUrl: config.baseUrl,
    inlineCompletionEnabled: config.inlineCompletionEnabled,
    chatEnabled: config.chatEnabled,
    agentEnabled: config.agentEnabled,
  });
  if (aiSettingsApiKey.value.trim()) {
    aiConfig.value = await aiService.saveCredentials({
      providerType: config.providerType,
      apiKey: aiSettingsApiKey.value,
    });
    aiSettingsApiKey.value = '';
  }
  aiSettingsDraft.value = { ...aiConfig.value };
  isAiSettingsOpen.value = false;
  emitSaved('AI 设置已保存');
};

const saveAiCredentials = async (apiKey: string): Promise<void> => {
  aiConfig.value = await aiService.saveCredentials({
    providerType: aiSettingsDraft.value.providerType,
    apiKey,
  });
  aiSettingsDraft.value = { ...aiConfig.value };
  aiSettingsApiKey.value = '';
  emitSaved('AI 凭证已保存');
};

const testAiProvider = async (): Promise<string> => {
  aiConfig.value = await aiService.saveConfig({
    providerType: aiSettingsDraft.value.providerType,
    selectedModel: aiSettingsDraft.value.selectedModel,
    baseUrl: aiSettingsDraft.value.baseUrl,
    inlineCompletionEnabled: aiSettingsDraft.value.inlineCompletionEnabled,
    chatEnabled: aiSettingsDraft.value.chatEnabled,
    agentEnabled: aiSettingsDraft.value.agentEnabled,
  });
  if (aiSettingsApiKey.value.trim()) {
    aiConfig.value = await aiService.saveCredentials({
      providerType: aiSettingsDraft.value.providerType,
      apiKey: aiSettingsApiKey.value,
    });
    aiSettingsApiKey.value = '';
  }
  aiSettingsDraft.value = { ...aiConfig.value };
  const result = await aiService.testProvider();
  emitSaved(result.message);
  return result.message;
};

const requestClose = async (): Promise<boolean> => {
  if (!props.open) {
    return true;
  }

  if (pendingCloseRequest) {
    return pendingCloseRequest;
  }

  pendingCloseRequest = (async () => {
    if (!isDirty.value) {
      emit('close');
      return true;
    }

    const action = await confirm({
      title: '保留设置更改？',
      description: '你已经修改了设置。退出前要保留这些变更，还是恢复到进入设置前的状态？',
      confirmText: '保留并退出',
      cancelText: '放弃更改',
      dismissText: '继续编辑',
      variant: 'warning',
    });

    if (action === 'confirm') {
      syncInitialSettingsSnapshot();
      emit('close');
      return true;
    }

    if (action === 'cancel') {
      appStore.replaceSettings(initialSettingsSnapshot.value);
      emitSaved('已放弃设置更改');
      emit('close');
      return true;
    }

    return false;
  })();

  try {
    return await pendingCloseRequest;
  } finally {
    pendingCloseRequest = null;
  }
};

const focusSearch = (): void => {
  searchInputRef.value?.focus();
  searchInputRef.value?.select();
};

watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen && !wasOpen) {
      syncInitialSettingsSnapshot();
      void loadAiConfig();
    }
  },
  { immediate: true },
);

watch(isSearching, () => {
  scrollToTop();
});

defineExpose<{
  focusSearch: () => void;
  requestClose: () => Promise<boolean>;
}>({
  focusSearch,
  requestClose,
});
</script>
