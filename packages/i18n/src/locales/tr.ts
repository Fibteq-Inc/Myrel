import type { Catalog } from "../index";

export const tr: Catalog = {
  // Shared
  "common.error": "Bir şeyler ters gitti",
  "common.copy": "Kopyala",
  "common.copied": "Kopyalandı",
  "common.member": "Üye",
  "common.comingSoon": "{label} (yakında)",
  "common.comingSoonTitle": "{label} · yakında",
  "common.language": "Dil",

  // Relative time
  "time.now": "şimdi",
  "time.minutes": { other: "{count} dk" },
  "time.hours": { other: "{count} sa" },
  "time.days": { other: "{count} g" },

  // Login
  "login.signInTitle": "Altair'e giriş yap",
  "login.signUpTitle": "Hesap oluştur",
  "login.name": "Ad",
  "login.email": "E-posta",
  "login.password": "Şifre",
  "login.signIn": "Giriş yap",
  "login.signUp": "Kaydol",
  "login.toSignUp": "Hesabın yok mu? Kaydol",
  "login.toSignIn": "Hesabın var mı? Giriş yap",
  "login.signUpClosed": "Bu sunucuda yeni kayıtlar kapalı.",

  // Server picker
  "server.current": "Sunucu: {host}",
  "server.change": "Değiştir",
  "server.label": "Altair sunucusu",
  "server.connect": "Bağlan",

  // Shell
  "shell.openMenu": "Menüyü aç",
  "shell.closeMenu": "Menüyü kapat",
  "rail.main": "Ana menü",
  "rail.home": "Altair ana sayfa",
  "rail.projects": "Projeler",
  "rail.artifacts": "Artifact'ler",
  "rail.files": "Dosyalar",
  "rail.devices": "Cihazlar ve çalıştırıcılar",
  "rail.settings": "Ayarlar",
  "rail.account": "Hesap",
  "rail.signOut": "Çıkış yap",

  // Projects page
  "projects.title": "Projeler",
  "projects.start": "Bir proje başlat",
  "projects.intro":
    "Proje, ortak bir sohbettir. İşi orada iste, Altair her görev için bir thread açar.",
  "projects.name": "Proje adı",
  "projects.create": "Oluştur",
  "projects.yours": "Projelerin",
  "projects.owner": "Sahip",
  "projects.member": "Üye",

  // Project sidebar
  "sidebar.label": "Proje ve thread'ler",
  "sidebar.searchThreads": "Thread'lerde ara",
  "sidebar.newRequest": "Yeni istek",
  "sidebar.projectChat": "Proje sohbeti",
  "sidebar.threads": "Thread'ler",
  "sidebar.noMatch": "Eşleşen thread yok.",
  "sidebar.noThreads": "Altair bir iş üstlendiğinde thread'ler burada açılır.",
  "sidebar.resolved": "Çözüldü",
  "sidebar.switchProject": "Proje değiştir",
  "sidebar.members": { other: "{count} üye" },
  "sidebar.current": "Şu anki",
  "sidebar.newProject": "Yeni proje",
  "connection.open": "Canlı",
  "connection.openDetail": "Güncellemeler anında geliyor",
  "connection.connecting": "Bağlanıyor",
  "connection.connectingDetail": "Sunucuya ulaşılıyor",
  "connection.closed": "Çevrimdışı",
  "connection.closedDetail": "Arka planda yeniden deneniyor",

  // Project chat
  "chat.title": "Proje sohbeti",
  "chat.membersLabel": { other: "{count} üye" },
  "chat.placeholder": "Altair'e bir görev ver",
  "chat.emptyTitle": "Altair ne üzerinde çalışsın?",
  "chat.emptyBody":
    "Her şeyi isteyebilirsin. Altair her iş için bir thread açar ve sonucu orada bildirir, böylece bu sohbet okunaklı kalır.",

  // Messages
  "message.copy": "Mesajı kopyala",
  "message.thinking": "Düşünüyor",
  "message.working": "Çalışıyor",
  "composer.send": "Gönder",
  "composer.newLineHint": "Yeni satır için Shift + Enter",
  "threadCard.replies": { other: "{count} yanıt" },
  "checklist.progress": "İlerleme",
  "checklist.done": "Tamamlandı",
  "checklist.inProgress": "Devam ediyor",
  "checklist.stopped": "Burada durdu",
  "checklist.todo": "Başlamadı",
  "decision.answered": "Yanıtlandı",
  "decision.yourCall": "Karar senin",
  "decision.recommended": "önerilen",
  "decision.chosen": "Seçildi",

  // Thread status
  "status.working": "Çalışıyor",
  "status.blocked": "Koordinatöre danışıyor",
  "status.reviewReady": "Seni bekliyor",
  "status.done": "Çözüldü",
  "status.failed": "Başarısız",

  // Thread view
  "thread.loading": "Thread yükleniyor",
  "thread.missing": "Bu thread yok ya da kaldırıldı.",
  "thread.backToChat": "Proje sohbetine dön",
  "thread.showWorkspace": "Çalışma alanını göster",
  "thread.hideWorkspace": "Çalışma alanını gizle",
  "thread.reopen": "Yeniden aç",
  "thread.resolve": "Çöz",
  "thread.messages": "Thread mesajları",
  "thread.placeholder": "Bu thread'de yanıtla",

  // Workspace
  "workspace.label": "Çalışma alanı",
  "workspace.tabs": "Çalışma alanı sekmeleri",
  "workspace.changes": "Değişiklikler",
  "workspace.changesEmpty": "Henüz değişiklik yok",
  "workspace.changesEmptyBody": "Bu thread kodu değiştirdiğinde fark ve pull request'i burada görünür.",
  "workspace.terminal": "Terminal",
  "workspace.terminalEmpty": "Henüz bir şey çalışmadı",
  "workspace.terminalEmptyBody":
    "Bu thread'in sandbox'ta ya da senin çalıştırıcında çalıştırdığı komutlar burada canlı akar.",
  "workspace.outputs": "Çıktılar",
  "workspace.outputsEmpty": "Henüz çıktı yok",
  "workspace.outputsEmptyBody": "Bu thread'in teslim ettiği dosyalar, artifact'ler ve bağlantılar burada toplanır.",
};
