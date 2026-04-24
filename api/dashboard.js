import { useEffect, useState } from "react";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

export default function Stats() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then(res => res.json())
      .then(setData);
  }, []);

  if (!data) return null;

  const labels = data.history.monthly.map(x => x.label);
  const plays = data.history.monthly.map(x => x.plays);

  return (
    <div style={{ height: 400 }}>
      <Bar
        data={{
          labels,
          datasets: [
            {
              label: "Plays",
              data: plays,
              backgroundColor: "#4f46e5"
            },
            {
              label: "Plays copy",
              data: plays,
              backgroundColor: "#22c55e"
            }
          ]
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: "index",
            intersect: false
          },
          scales: {
            x: { stacked: false },
            y: { stacked: false }
          },
          datasets: {
            bar: {
              categoryPercentage: 0.7,
              barPercentage: 0.8
            }
          }
        }}
      />
    </div>
  );
}
