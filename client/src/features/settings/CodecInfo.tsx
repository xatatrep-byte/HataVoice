import { InfoTip } from "../../ui/InfoTip";

/** The badge of the codec that suits this PC best (by its video card), once that is known. */
const forThisPc = <span className="infotip-badge">для этого ПК</span>;

/** What each screen codec does and which to pick: the card behind the «i» next to «Кодек». */
export function CodecInfo({ best }: { best?: "av1" | "h264" }) {
  return (
    <InfoTip label="Чем отличаются кодеки">
      <p>Кодек сжимает картинку экрана, чтобы она пролезла в интернет. От него зависят чёткость, плавность и нагрузка на ПК.</p>
      <dl>
        <div>
          <dt>
            Авто {!best && <span className="infotip-badge">советуем</span>}
          </dt>
          <dd>Сам выбирает лучшее для этого ПК: AV1, если его кодирует видеокарта, иначе H.264. Думать ни о чём не нужно.</dd>
        </div>
        <div>
          <dt>AV1 {best === "av1" && forThisPc}</dt>
          <dd>
            Самая чёткая картинка при той же скорости интернета: на 30–50% экономнее H.264, мелкий текст и быстрые сцены
            не рассыпаются на квадраты. Нужна видеокарта, которая его кодирует: NVIDIA RTX 40 и новее, AMD RX 7000 и новее,
            Intel Arc. Без неё AV1 считает процессор, и картинка идёт рывками.
          </dd>
        </div>
        <div>
          <dt>H.264 {best === "h264" && forThisPc}</dt>
          <dd>
            Самый лёгкий и надёжный: его кодирует почти любая видеокарта, у зрителей он почти не грузит ПК. Картинка
            чуть мягче, чем у AV1, особенно на тексте и в динамике.
          </dd>
        </div>
        <div>
          <dt>VP9</dt>
          <dd>
            Кодируется процессором, зато режется на слои: зрителю со слабым интернетом сервер отдаёт уменьшенную копию
            вместо тормозящей полной. Грузит процессор сильнее всех — выбирай, если у кого-то из друзей медленный интернет.
          </dd>
        </div>
      </dl>
      <table className="infotip-table">
        <thead>
          <tr>
            <th></th>
            <th>Чёткость</th>
            <th>Нагрузка</th>
            <th>Слабым зрителям</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>AV1</th>
            <td className="good">лучшая</td>
            <td className="good">низкая*</td>
            <td>хорошо</td>
          </tr>
          <tr>
            <th>H.264</th>
            <td>хорошая</td>
            <td className="good">низкая</td>
            <td className="bad">одна копия</td>
          </tr>
          <tr>
            <th>VP9</th>
            <td>хорошая</td>
            <td className="bad">высокая</td>
            <td className="good">лучше всех</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">* на видеокарте с AV1; без неё — высокая.</p>
    </InfoTip>
  );
}
