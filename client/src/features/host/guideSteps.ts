/**
 * How friends get to this PC's server, step by step, for someone who knows computers little: with nothing to set up
 * (the link that finds its way), through a shared virtual network (Radmin VPN, ZeroTier One) or a public IP. Each way
 * has the owner's steps and the friend's; the friend's can be copied as plain text to send in a messenger.
 *
 * Every name in quotes is what the person sees on the screen: a button, a tab, a menu item, here or in the other
 * program (Radmin VPN and ZeroTier as of November 2026: radmin-vpn.com/ru/help, docs.zerotier.com/start). One step is one
 * thing to do, and `check` says what should be on the screen after it.
 */

export type GuideWay = "link" | "radmin" | "zerotier" | "public";

export type GuideStep = { title: string; text: string; check?: string };

export type Guide = {
  label: string;
  /** One line under the tabs: when to choose this way. */
  when: string;
  host: GuideStep[];
  friend: GuideStep[];
};

/** What the server knows of itself that the steps can name. */
export type GuideFacts = {
  /** «26.10.20.30:7350» when the server sees Radmin VPN on this PC (it looks at its start). */
  radmin: string | null;
  zerotier: string | null;
  /** This PC is in Radmin VPN / ZeroTier now, whether the server saw it at its start or not (then: restart). */
  radminNow?: boolean;
  zerotierNow?: boolean;
  /** The public address, when ports are open and it works. */
  publicAddress: string | null;
  publicWorks: boolean;
  /** The ports to open on a router, «TCP 7350, TCP 7881, UDP 7882». */
  ports: string;
  /** The server's address by its key («….p2p») when «без белого IP» is on and running; null otherwise. */
  p2p: string | null;
  /** What the router's own outside address is: a public one, the provider's grey one, another router's; null: unknown. */
  ipKind?: "public" | "cgnat" | "private" | null;
  /** The outside address the server found, and this PC's address in the home network. */
  publicIp?: string | null;
  localIp?: string | null;
  /** The server is on now. */
  running?: boolean;
};

export const GUIDE_WAYS: readonly GuideWay[] = ["link", "radmin", "zerotier", "public"];

/** Where the owner's server lives in the app. */
const MY_SERVER = "Нажми на свой кружок-аватар в правом верхнем углу ХатаВойс → «Настройки» → слева «Мой сервер».";
/** The server's menu. */
const SERVER_MENU = "Нажми стрелку ▾ рядом с названием сервера в левом верхнем углу ХатаВойс";

const FIREWALL: GuideStep = {
  title: "Если друг не может подключиться — разреши сервер в брандмауэре Windows",
  text:
    "Нажми «Пуск», начни печатать «брандмауэр» и открой «Брандмауэр Защитника Windows». Слева нажми «Разрешение " +
    "взаимодействия с приложением или компонентом в брандмауэре Защитника Windows», затем кнопку «Изменить параметры». " +
    "Найди в списке hatavoice-server и livekit-server и у каждого поставь обе галочки справа — и частная, и публичная " +
    "сеть. Нажми «ОК». Если их нет в списке: «Разрешить другое приложение…» → «Обзор…» → вставь в адресную строку " +
    "%LOCALAPPDATA%\\HataVoice → выбери hatavoice-server.exe → «Добавить»; так же livekit-server.exe. Вторая галочка важна: " +
    "сети Radmin VPN и ZeroTier Windows обычно считает публичными.",
  check: "У hatavoice-server и livekit-server стоят обе галочки.",
};

const FIRST_START: GuideStep = {
  title: "Разреши доступ, когда Windows спросит",
  text:
    "При первом включении сервера Windows покажет окно «Оповещение системы безопасности Windows» — для hatavoice-server " +
    "и для livekit-server. В каждом поставь обе галочки (частные и общественные сети) и нажми «Разрешить доступ». " +
    "Если окно уже было и ты нажал «Отмена» — это исправляется последним шагом.",
};

/**
 * The owner's invite carrying one address of the list (Radmin VPN, ZeroTier, the internet). `absent`: what to do when
 * the list has no such address yet.
 */
const INVITE_WITH = (label: string, address: string | null, absent: string): GuideStep[] => [
  {
    title: "Открой приглашения сервера",
    text: `${SERVER_MENU} → «Настройки сервера» → вкладка «Приглашения».`,
  },
  {
    title: `Выбери адрес «${label}»`,
    text:
      "Под надписью «Адрес для друзей» — поле со стрелкой ▾ справа; в нём уже написана первая строка списка (обычно «Интернет: …»). " +
      `Нажми на это поле — раскроется список. Выбери в нём строку «${label}: …»` +
      (address ? ` — у тебя это «${label}: ${address}».` : ".") +
      (address ? "" : ` ${absent}`) +
      " Ниже выбери «Сколько раз» — сколько друзей зайдёт по одной ссылке (например «25 раз»), и «Срок» — например «7 дней».",
    check: `В поле «Адрес для друзей» написано «${label}: ${address ?? "…"}».`,
  },
  {
    title: "Создай ссылку и скопируй её",
    text: "Нажми «Создать ссылку», затем «Копировать». Ссылка показывается один раз — сразу отправь её другу.",
    check: "Ссылка начинается с hatavoice://",
  },
];

const INSTALL_APP: GuideStep = {
  title: "Поставь ХатаВойс",
  text:
    "Запусти установщик ХатаВойс, который тебе прислали. Если Windows покажет синее окно «Система Windows защитила ваш " +
    "компьютер» — нажми «Подробнее», затем «Выполнить в любом случае». В установщике нажми «Установить», потом «Готово».",
};

const FIRST_RUN: GuideStep = {
  title: "Пройди первый запуск",
  text:
    "ХатаВойс спросит «Как тебя зовут?» — впиши ник и нажми «Дальше». На «Проверим звук» выбери микрофон и нажми «Дальше». " +
    "На «Куда подключимся?» нажми «Подключиться к другу».",
  check: "Открылось окно «Добавить сервер» с полем «Ссылка-приглашение или адрес».",
};

const OPEN_LINK: GuideStep = {
  title: "Вставь ссылку-приглашение и войди",
  text:
    "Скопируй ссылку целиком (она начинается с hatavoice://), вставь её в поле «Ссылка-приглашение или адрес» (Ctrl+V) " +
    "и нажми «Подключиться». Появится название сервера — нажми «Войти». Если ссылка уже скопирована, ХатаВойс сам откроет " +
    "это окно — останется нажать «Войти». Потом, чтобы добавить ещё сервер: стрелка ▾ рядом с названием сервера → «Добавить сервер».",
  check: "Вверху окна — название сервера друга.",
};

function linkWay(facts: GuideFacts): Guide {
  const on = !!facts.p2p;
  return {
    label: "Без настроек",
    when:
      "Начни с этого способа: белый IP, роутер и другие программы не нужны. Ваши ХатаВойс находят друг друга по ключу " +
      "сервера и пробивают связь через роутеры напрямую — так же соединяются торренты и игры. Если напрямую не выходит, связь " +
      "идёт через промежуточный узел сети iroh; он видит только зашифрованный поток, а не голос и не чат.",
    host: [
      {
        title: "Открой «Мой сервер»",
        text: MY_SERVER,
      },
      on
        ? {
            title: "Связь без белого IP уже включена",
            text: `Сервер работает, его адрес по ключу — ${facts.p2p!.slice(0, 12)}….p2p. Через него друзья и зайдут. Ничего менять не нужно.`,
          }
        : {
            title: "Включи «Без белого IP»",
            text:
              "Ниже, в блоке «Как друзья заходят», включи переключатель «Без белого IP — по ключу сервера» и нажми «Применить»" +
              (facts.running ? " — сервер перезапустится сам." : ", затем «Включить»."),
            check: "Рядом с «Без белого IP — по ключу сервера» написано «Работает».",
          },
      {
        title: "Скопируй приглашение",
        text: `${SERVER_MENU} → «Позвать друга». Ссылка сразу скопируется — внизу появится «Ссылка скопирована».`,
      },
      {
        title: "Отправь другу ссылку и установщик",
        text: "В Telegram, VK, Discord — куда удобно: ссылку и файл установщика ХатаВойс. Кнопка ниже скопирует пошаговую инструкцию для друга.",
      },
      {
        title: "Держи ПК включённым",
        text: "Друзья заходят, только пока этот ПК включён и сервер в «Мой сервер» работает.",
      },
    ],
    friend: [
      INSTALL_APP,
      FIRST_RUN,
      OPEN_LINK,
      {
        title: "Подожди до полуминуты при первом входе",
        text: "Программы сначала ищут, как пройти через ваши роутеры. Потом вход быстрый.",
      },
      {
        title: "Если так и не подключилось",
        text:
          "Значит, сеть твоего провайдера, работы или школы режет и прямую связь, и промежуточный узел. Тогда возьмите Radmin VPN — " +
          "это 5 минут, шаги во вкладке «Radmin VPN».",
      },
    ],
  };
}

const RADMIN_INSTALL: GuideStep = {
  title: "Поставь и включи Radmin VPN",
  text:
    "Открой radmin-vpn.com, скачай программу кнопкой на главной странице, установи и запусти. Если вверху окна Radmin VPN " +
    "ошибка или он выключен — нажми большую круглую кнопку включения.",
  check: "Вверху окна Radmin VPN — твой адрес вида 26.x.x.x.",
};

/** Whether the server sees a shared network: the step before the invite, as the server says it is now. */
function netSeen(label: string, address: string | null, now: boolean): GuideStep {
  if (address) {
    return { title: `Сервер уже видит ${label}`, text: `Перезапускать ничего не нужно: твой адрес в ${label} — ${address}.` };
  }
  if (now) {
    return {
      title: "Перезапусти сервер ХатаВойс",
      text: `${label} включили, когда сервер уже работал, — он увидит сеть только после перезапуска. ${MY_SERVER} В блоке «Как друзья заходят» нажми «Перезапустить сервер» (или «Выключить», потом «Включить»).`,
      check: `В списке «Адрес для друзей» (следующие шаги) есть строка «${label}: …».`,
    };
  }
  return {
    title: `Перезапусти сервер, когда ${label} заработает`,
    text:
      `Сейчас ХатаВойс не видит ${label} на этом ПК, поэтому строки «${label}: …» в списке адресов пока нет — там серая ` +
      `строка «${label} — не найден на этом ПК». Сделай шаги выше на этом ПК (на том, где работает сервер). Потом открой «Мой сервер» (свой кружок-аватар в ` +
      "правом верхнем углу → «Настройки» → слева «Мой сервер») и нажми «Перезапустить сервер» в блоке «Как друзья заходят» (или «Выключить», потом «Включить»).",
    check: `Серая строка пропала, вместо неё — «${label}: …».`,
  };
}

/** One line on top of a shared network's steps when it is not needed at all. */
const NOT_NEEDED = (label: string) =>
  `Тебе ${label} не нужен: у тебя белый IP и порты открыты — друзья уже заходят по ссылке с адресом «Интернет» (вкладка ` +
  `«Белый IP»). ${label} пригодится, только если у кого-то из друзей так не соединяется.`;

function radminWay(facts: GuideFacts): Guide {
  const now = facts.radminNow === true || !!facts.radmin;
  return {
    label: "Radmin VPN",
    when:
      (facts.publicWorks ? NOT_NEEDED("Radmin VPN") + " " : "Запасной путь, если «Без настроек» у кого-то не соединяется. ") +
      "Бесплатная программа делает общую сеть для тебя и друзей; работает и с серым IP. Ставят все: и ты, и каждый друг.",
    host: [
      now
        ? { title: "Radmin VPN на этом ПК уже включён", text: "ХатаВойс его видит. Ставить ничего не нужно." }
        : {
            ...RADMIN_INSTALL,
            title: "Поставь и включи Radmin VPN на этом ПК",
            text: `Сейчас ХатаВойс не видит Radmin VPN на этом ПК. Ставь его сюда — на ПК, где работает сервер. ${RADMIN_INSTALL.text}`,
          },
      {
        title: "Создай сеть",
        text:
          "В Radmin VPN нажми «Создать сеть». Впиши имя сети (например «hata-ivan») и пароль, нажми «Создать». Запиши имя и пароль — их нужно отправить друзьям.",
        check: "В списке Radmin VPN появилась твоя сеть и твой ПК в ней.",
      },
      netSeen("Radmin VPN", facts.radmin, now),
      ...INVITE_WITH("Radmin VPN", facts.radmin, "Если вместо неё серая строка «Radmin VPN — не найден на этом ПК» или «… перезапусти сервер» — вернись к шагам 1 и 3."),
      {
        title: "Отправь другу всё нужное",
        text:
          "Нажми ниже «Скопировать инструкцию для друга», вставь её в мессенджер и допиши в конце имя сети, пароль и ссылку. " +
          "Отправь вместе с установщиком ХатаВойс.",
      },
      FIRST_START,
      FIREWALL,
    ],
    friend: [
      RADMIN_INSTALL,
      {
        title: "Войди в сеть друга",
        text: "В Radmin VPN нажми «Присоединиться к сети», впиши имя сети и пароль из сообщения и нажми «Присоединиться».",
        check: "В списке Radmin VPN — сеть друга и его ПК с зелёным значком (значит, он в сети).",
      },
      INSTALL_APP,
      FIRST_RUN,
      OPEN_LINK,
      {
        title: "Перед каждым звонком",
        text: "Radmin VPN должен быть запущен и у тебя, и у друга: ПК друга в списке — с зелёным значком.",
      },
    ],
  };
}

const ZEROTIER_INSTALL: GuideStep = {
  title: "Поставь ZeroTier One",
  text: "Скачай программу с zerotier.com/download (вариант для Windows) и установи. Значок ZeroTier появится у часов в правом нижнем углу (может прятаться под стрелкой ^).",
};

const ZEROTIER_JOIN = (title: string): GuideStep => ({
  title,
  text:
    "Нажми на значок ZeroTier у часов → «Join New Network…» → вставь Network ID (16 знаков) → «Join». Если Windows спросит, " +
    "разрешить ли другим устройствам в этой сети обнаруживать компьютер, — нажми «Да».",
});

function zerotierWay(facts: GuideFacts): Guide {
  const now = facts.zerotierNow === true || !!facts.zerotier;
  return {
    label: "ZeroTier One",
    when:
      (facts.publicWorks ? NOT_NEEDED("ZeroTier") + " " : "Ещё один запасной путь. ") +
      "Общая сеть, где ты сам решаешь, кого пускать, на сайте ZeroTier. Бесплатно — до 10 устройств " +
      "(ты и 9 друзей); если друзей больше, бери Radmin VPN. Ставят все.",
    host: [
      {
        title: "Заведи сеть на сайте ZeroTier",
        text:
          "Открой central.zerotier.com и зарегистрируйся. Впиши название организации (любое) → «Create Organization» → выбери " +
          "бесплатный план «Personal». Сеть создастся сама.",
      },
      {
        title: "Скопируй номер сети",
        text: "На сайте слева раскрой «Networks», открой свою сеть. Вверху страницы — Network ID из 16 знаков: скопируй его.",
      },
      ZEROTIER_INSTALL,
      ZEROTIER_JOIN("Войди в свою сеть"),
      {
        title: "Пусти в сеть свой ПК",
        text:
          "На сайте в своей сети открой вкладку «Member Devices». Напротив своего ПК (статус «Not Authorized») нажми «⋯» в " +
          "колонке «Actions» → «Authorize». Или нажми «Authorize» в полосе вверху, если она появилась. Если ПК не видно — обнови страницу.",
        check: "У ПК статус сменился и появился адрес ZeroTier.",
      },
      netSeen("ZeroTier", facts.zerotier, now),
      ...INVITE_WITH("ZeroTier", facts.zerotier, "Если вместо неё серая строка «ZeroTier — не найден на этом ПК» или «… перезапусти сервер» — вернись к шагам 3–6."),
      {
        title: "Отправь другу всё нужное",
        text: "Нажми ниже «Скопировать инструкцию для друга», допиши Network ID и ссылку, отправь вместе с установщиком ХатаВойс.",
      },
      {
        title: "Пусти друга, когда он вошёл в сеть",
        text: "На сайте во вкладке «Member Devices» появится его ПК со статусом «Not Authorized»: «⋯» → «Authorize». Пока не пустишь, друг не подключится.",
      },
      FIRST_START,
      FIREWALL,
    ],
    friend: [
      ZEROTIER_INSTALL,
      ZEROTIER_JOIN("Войди в сеть друга"),
      {
        title: "Напиши другу, что вошёл",
        text: "Он должен пустить тебя на сайте ZeroTier. До этого сервер не откроется.",
      },
      INSTALL_APP,
      FIRST_RUN,
      OPEN_LINK,
    ],
  };
}

function publicWay(facts: GuideFacts): Guide {
  const ip = facts.publicIp ?? null;
  const kind = facts.ipKind ?? null;
  const check: GuideStep =
    kind === "public"
      ? { title: "Белый IP есть", text: `Твой внешний адрес — ${ip ?? "белый"}: этот способ подходит.` }
      : kind === "cgnat"
        ? {
            title: "У тебя серый IP — этот способ не подойдёт",
            text: "Провайдер дал адрес, общий для многих абонентов: из интернета к этому ПК не достучаться. Бери «Без настроек» или Radmin VPN. Белый IP можно заказать у провайдера (часто платно).",
          }
        : kind === "private"
          ? {
              title: "Твой роутер стоит за другим роутером",
              text: "Порты придётся открывать на обоих роутерах. Проще взять «Без настроек» или Radmin VPN.",
            }
          : {
              title: "Проверь, белый ли у тебя IP",
              text:
                "Открой настройки роутера (как — в следующем шаге) и найди на главной странице «IP-адрес» подключения к интернету (WAN). " +
                "Потом открой 2ip.ru. Если адреса совпадают — IP белый. Если адрес роутера начинается с 10., 100.64–100.127, 172.16–172.31 или 192.168. — серый, бери «Без настроек».",
            };
  const pc = facts.localIp ?? "адрес этого ПК (Win+R → cmd → ipconfig → «IPv4-адрес»)";
  return {
    label: "Белый IP",
    when: facts.publicWorks
      ? "У тебя белый IP и порты открыты — друзья подключаются прямо к тебе, без посредников и без других программ."
      : "Самый прямой путь, без посредников, — если провайдер дал белый IP. Нужно один раз открыть порты на роутере.",
    host: [
      check,
      facts.publicWorks
        ? { title: "Порты уже открыты", text: "Сервер сам открыл их на роутере (UPnP). Переходи к приглашению." }
        : {
            title: "Открой настройки роутера",
            text:
              "Нажми Win+R, впиши cmd, нажми Enter, впиши ipconfig, нажми Enter. Найди строку «Основной шлюз» (например 192.168.0.1) " +
              "и открой этот адрес в браузере. Логин и пароль обычно на наклейке снизу роутера.",
          },
      ...(facts.publicWorks
        ? []
        : [
            {
              title: "Пробрось три порта на этот ПК",
              text:
                "Найди раздел «Переадресация портов» — у разных роутеров он называется ещё «Проброс портов», «Виртуальные серверы» " +
                `или «Port Forwarding». Добавь по правилу на каждый порт: ${facts.ports}. В каждом правиле внешний и внутренний порт ` +
                `одинаковые, протокол — как написано (TCP или UDP), адрес — ${pc}. Сохрани.`,
              check: "В списке правил роутера — три строки с этими портами.",
            },
          ]),
      ...INVITE_WITH(
        "Интернет",
        facts.publicAddress,
        "Если такой строки нет — сервер не узнал внешний адрес: в «Мой сервер» открой «Дополнительно: порты и внешний IP», впиши внешний IP с 2ip.ru и нажми «Применить».",
      ),
      FIRST_START,
      FIREWALL,
    ],
    friend: [INSTALL_APP, FIRST_RUN, OPEN_LINK],
  };
}

export function guideFor(way: GuideWay, facts: GuideFacts): Guide {
  switch (way) {
    case "link":
      return linkWay(facts);
    case "radmin":
      return radminWay(facts);
    case "zerotier":
      return zerotierWay(facts);
    case "public":
      return publicWay(facts);
  }
}

/** The friend's steps as one plain message to send. */
export function friendMessage(way: GuideWay, facts: GuideFacts): string {
  const guide = guideFor(way, facts);
  const lines = guide.friend.map((step, i) => `${i + 1}. ${step.title}\n${step.text}${step.check ? `\nДолжно получиться: ${step.check}` : ""}`);
  const extra = way === "radmin" ? "\nИмя сети: \nПароль: " : way === "zerotier" ? "\nНомер сети (Network ID): " : "";
  return `Как зайти на мой сервер ХатаВойс (${guide.label}):\n\n${lines.join("\n\n")}\n${extra}\nСсылка-приглашение: `;
}
