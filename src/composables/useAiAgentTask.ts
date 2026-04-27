import { ref } from 'vue';
import { aiService } from '@/services/modules/ai';
import type { IAiContextReference, IAiTaskPlanStep } from '@/types/ai';

export const useAiAgentTask = () => {
  const steps = ref<IAiTaskPlanStep[]>([]);
  const isPlanning = ref(false);

  const planTask = async (
    goal: string,
    context: IAiContextReference[] = [],
  ): Promise<IAiTaskPlanStep[]> => {
    isPlanning.value = true;
    try {
      const payload = await aiService.planTask({ goal, context });
      steps.value = payload.steps;
      return steps.value;
    } finally {
      isPlanning.value = false;
    }
  };

  const cancel = (): void => {
    steps.value = steps.value.map((step) =>
      step.status === 'completed' ? step : { ...step, status: 'failed' },
    );
    isPlanning.value = false;
  };

  return { steps, isPlanning, planTask, cancel };
};