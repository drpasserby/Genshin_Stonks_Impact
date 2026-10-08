<template>
  <div class="login-page">
    <div class="login-card ts-card">
      <div class="logo">
        <div class="logo-mark">⚜️</div>
        <h1 class="logo-title">提瓦特证券交易所</h1>
        <p class="logo-sub">Teyvat Stock Exchange · 角色模拟炒股</p>
      </div>

      <el-tabs v-model="tab" stretch>
        <el-tab-pane label="登录" name="login">
          <el-form :model="loginForm" :rules="loginRules" ref="loginFormRef" label-position="top" @submit.prevent>
            <el-form-item label="用户名" prop="username">
              <el-input v-model="loginForm.username" placeholder="请输入用户名" size="large" />
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input v-model="loginForm.password" type="password" show-password placeholder="请输入密码" size="large" @keyup.enter="onLogin" />
            </el-form-item>
            <el-button type="primary" size="large" class="w-full" :loading="loading" @click="onLogin">登 录</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane :label="allowRegistration ? '注册' : '注册(未开放)'" name="register">
          <el-alert
            v-if="!allowRegistration"
            type="warning"
            :closable="false"
            show-icon
            title="系统暂未开放自助注册"
            description="如需开通账号，请联系管理员创建。"
            style="margin-bottom: 12px"
          />
          <el-alert
            v-else-if="deviceUsed"
            type="error"
            :closable="false"
            show-icon
            title="此设备已注册过账号"
            description="为防止刷号，同一台设备仅可注册一个账号。如需新账号请联系管理员。"
            style="margin-bottom: 12px"
          />
          <el-form :model="regForm" :rules="regRules" ref="regFormRef" label-position="top" @submit.prevent>
            <el-form-item label="用户名" prop="username">
              <el-input v-model="regForm.username" placeholder="3~32位，登录使用" size="large" :disabled="regDisabled" />
            </el-form-item>
            <el-form-item label="昵称" prop="nickname">
              <el-input v-model="regForm.nickname" placeholder="选填，展示用" size="large" :disabled="regDisabled" />
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input v-model="regForm.password" type="password" show-password placeholder="至少6位" size="large" :disabled="regDisabled" />
            </el-form-item>
            <el-form-item label="确认密码" prop="confirm">
              <el-input v-model="regForm.confirm" type="password" show-password placeholder="再次输入密码" size="large" :disabled="regDisabled" @keyup.enter="onRegister" />
            </el-form-item>
            <el-button type="primary" size="large" class="w-full" :disabled="regDisabled" :loading="loading" @click="onRegister">注册并赠送 100 万摩拉</el-button>
            <p class="device-tip">同一台设备仅可注册一个账号，请在常用设备上注册。</p>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { useSystemStore } from '@/stores/system';
import { isDeviceRegistered, markDeviceBlocked } from '@/utils/device';

const tab = ref<'login' | 'register'>('login');
const loading = ref(false);
const router = useRouter();
const route = useRoute();
const store = useUserStore();
const sysStore = useSystemStore();
const allowRegistration = computed(() => sysStore.allowRegistration);

/** 本设备是否已注册过账号（前端标记；服务端还有权威校验） */
const deviceUsed = ref(isDeviceRegistered());
const regDisabled = computed(() => !allowRegistration.value || deviceUsed.value);

const loginForm = reactive({ username: '', password: '' });
const regForm = reactive({ username: '', nickname: '', password: '', confirm: '' });
const loginFormRef = ref<FormInstance>();
const regFormRef = ref<FormInstance>();

const loginRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};
const regRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '长度 3~32 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 64, message: '至少 6 位', trigger: 'blur' },
  ],
  confirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => (v === regForm.password ? cb() : cb(new Error('两次密码不一致'))),
      trigger: 'blur',
    },
  ],
};

async function gotoHome() {
  const redirect = (route.query.redirect as string) || '/';
  router.push(redirect);
}

async function onLogin() {
  const valid = await loginFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  loading.value = true;
  try {
    await store.login(loginForm.username.trim(), loginForm.password);
    ElMessage.success('登录成功，欢迎回来！');
    await gotoHome();
  } catch { /* 错误已全局提示 */ } finally { loading.value = false; }
}

async function onRegister() {
  if (!allowRegistration.value) {
    ElMessage.warning('系统暂未开放自助注册');
    return;
  }
  if (deviceUsed.value) {
    ElMessage.warning('此设备已注册过账号，一台设备仅可注册一个账号');
    return;
  }
  const valid = await regFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  loading.value = true;
  try {
    await store.register(regForm.username.trim(), regForm.password, regForm.nickname.trim() || undefined);
    deviceUsed.value = true;
    ElMessage.success('注册成功！已赠送 100 万摩拉');
    await gotoHome();
  } catch (e: unknown) {
    // 服务端驳回「该设备已注册」时同步前端标记，避免反复无效尝试
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 403) {
      deviceUsed.value = true;
      markDeviceBlocked();
    }
  } finally { loading.value = false; }
}

onMounted(() => {
  sysStore.fetchMeta();
});
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background:
    radial-gradient(ellipse at 30% 10%, rgba(230, 200, 130, 0.35), transparent 55%),
    radial-gradient(ellipse at 80% 90%, rgba(200, 160, 90, 0.25), transparent 50%),
    var(--ts-bg);
}
.login-card { width: 100%; max-width: 420px; padding: 28px 30px; }
.logo { text-align: center; margin-bottom: 18px; }
.logo-mark { font-size: 44px; line-height: 1; filter: drop-shadow(0 2px 6px rgba(160, 120, 50, 0.4)); }
.logo-title { margin: 10px 0 4px; font-size: 24px; color: var(--ts-gold-dark); letter-spacing: 2px; }
.logo-sub { margin: 0; font-size: 12px; color: var(--ts-ink-soft); letter-spacing: 1px; }
.w-full { width: 100%; }
.device-tip { margin: 10px 0 0; font-size: 11px; color: #a08a60; text-align: center; line-height: 1.6; }
.demo-tip { margin: 14px 0 0; font-size: 11px; color: #a08a60; text-align: center; }
</style>
