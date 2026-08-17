# avito-cdp — баги, найденные при использовании скилла агентом

Пакет: `avito-cdp` 0.1.0, node v24.13.0, macOS (Darwin 27.0.0).
Браузер: профиль `/Users/bat/Library/Application Support/net.imput.helium`, подключение работало.
Сценарий: поиск мастера по замене аккумулятора MacBook Air M2 в Москве.

Ниже точные команды и текст ошибок. Всё воспроизводимо запуском команд как есть.

---

## 1. `get-categories` падает на обычном московском поиске

```bash
avito search "замена аккумулятора macbook air m2" -f json > s1.json
avito get-categories "$(jq -r '.[0].searchUrl' s1.json)"
```

searchUrl был:
`https://www.avito.ru/moskva?localPriority=1&q=замена+аккумулятора+macbook+air+m2`

Вывод, код возврата 1:

```
COMMAND_EXEC: Avito category sidebar node 1000007 has inconsistent type/state
```

Побочный эффект: `move-category` принимает `name` только из `get-categories`,
поэтому при падении первой вторая тоже становится недоступна — если Avito определил
категорию не так, как нужно, исправить нечем.

---

## 2. `get-item` теряет цену у услуг

В строке поиска цена есть, в детальной карточке того же объявления `price: null`.

```bash
avito search "замена аккумулятора macbook" -f json | jq -r '.[] | select(.itemId=="8052297817") | {itemId,price,title}'
# → { "itemId": "8052297817", "price": 2000, "title": "Замена аккумулятора MacBook Air / Pro" }

avito get-item "https://www.avito.ru/moskva/predlozheniya_uslug/zamena_akkumulyatora_macbook_air_pro_8052297817" -f json | jq -r '.[0] | {itemId,price,title}'
# → { "itemId": "8052297817", "price": null, "title": "Замена аккумулятора MacBook Air / Pro" }
```

Так у всех услуг, что открывал (`7993750444`, `3286794751`, `8052297817`, `8021515610`) —
везде `price: null`. Похоже, не разбирается форма «от 2000 ₽», которой Avito рисует услуги.

---

## 3. `get-item` возвращает массив из одного элемента

Не описано ни в `--help`, ни в SKILL.md. `search` → массив (ожидаемо), `get-item` → тоже массив.

```bash
avito get-item "https://www.avito.ru/moskva/predlozheniya_uslug/zamena_akkumulyatora_macbook_air_pro_8052297817" -f json | jq -r '.title'
# → jq: error (at <stdin>:33): Cannot index array with string "title"
```

Приходится писать `jq '.[0].title'` или `jq 'if type=="array" then .[0] else . end'`.

---

## 4. SKILL.md ссылается на несуществующий файл

В SKILL.md: «`docs/STATUS.md` has the current register.»

```bash
cat /Users/bat/.claude/skills/avito/docs/STATUS.md
# → cat: ...: No such file or directory
ls /Users/bat/.claude/skills/avito
# → SKILL.md        (больше ничего)
```

Реестр известных проблем, к которому отправляет документация, отсутствует —
как раз там, куда идёшь после падений из пунктов 1 и 2.

---

## 5. `-f json` в SKILL.md описан наоборот

В SKILL.md: «Add `-f json` when you need to read fields programmatically» —
читается так, будто по умолчанию таблица. На деле json и есть значение по умолчанию:

```bash
avito get-item "<url>"            # → уже JSON, без -f
avito search x -f bogus           # → ARGUMENT: format must be one of: json, table
avito --help | head -1            # → avito <command> [arguments] [--format json|table]
```

Флаг `-f json` приписывался к каждому вызову впустую.

---

## 6. Нет `--version`

```bash
avito --version
# → печатает обычный --help, версию узнать нечем
```

Версию пришлось доставать так:

```bash
readlink -f $(which avito)   # → /Users/bat/Desktop/code-me/avito-cdp-skill/bin/avito.mjs
grep version package.json    # → "version": "0.1.0"
```

Для баг-репортов от пользователей это стоит починить в первую очередь.
